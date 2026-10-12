(async function() {
    while (!window.Spicetify || !Spicetify.Player || !Spicetify.Player.data || !Spicetify.Menu) {
        await new Promise(r => setTimeout(r, 100));
    }

    // Languages 
    const LANGUAGES = {
        "en": "English",
        "zh-CN": "Chinese (Simplified)",
        "zh-TW": "Chinese (Traditional)",
        "ja": "Japanese",
        "ko": "Korean",
        "es": "Spanish",
        "fr": "French",
        "de": "German",
        "it": "Italian",
        "pt": "Portuguese",
        "ru": "Russian",
        "ar": "Arabic",
        "hi": "Hindi",
        "th": "Thai",
        "vi": "Vietnamese",
        "id": "Indonesian",
        "tr": "Turkish",
        "pl": "Polish",
        "nl": "Dutch",
        "sv": "Swedish",
        "uk": "Ukrainian",
        "he": "Hebrew",
        "el": "Greek",
        "tl": "Filipino"
        // add more based on google translate
    };

    // Settings 
    const STORAGE_KEY = "translator:settings";
    const defaults = {
        mode: "manual",
        display: "both",
        target: "en"
    };

    function loadSettings() {
        try {
            const s = { ...defaults, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
            if (!LANGUAGES[s.target]) s.target = defaults.target;
            return s;
        } catch {
            return { ...defaults };
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
        } catch (e) {
            console.error("Could not save settings:", e);
        }
    }

    const settings = loadSettings();

    // Translation
    const CACHE_KEY = "translator:cache:v1";
    const MAX_CACHE = 2000;
    const NETWORK_DELAY = 600; // ms to wait before calling the API (lets you skip tracks freely)
    const MIN_GAP = 400;       // min ms between requests

    function loadCache() {
        try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "[]"); }
        catch { return []; }
    }

    const cache = new Map(loadCache());
    let saveTimer;

    function saveCacheSoon() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            try { localStorage.setItem(CACHE_KEY, JSON.stringify([...cache])); } catch { }
        }, 2000);
    }

    function cacheSet(key, value) {
        cache.delete(key);
        cache.set(key, value);
        while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value); // drop oldest
        saveCacheSoon();
    }

    const cacheKey = (text, target = settings.target) => `${target}|${text.trim()}`;
    const inflight = new Map();
    let blockedUntil = 0;
    let failCount = 0;

    // Serialises requests and enforces a minimum gap between them
    let lastRequestAt = 0;
    let queue = Promise.resolve();
    function throttled(fn) {
        const run = queue.then(async () => {
            const wait = lastRequestAt + MIN_GAP - Date.now();
            if (wait > 0) await new Promise(r => setTimeout(r, wait));
            lastRequestAt = Date.now();
            return fn();
        });
        queue = run.catch(() => { });
        return run;
    }

    async function gtxTitle(text, sl, tl) {
        const url =
            "https://translate.googleapis.com/translate_a/single" +
            `?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
        const res = await throttled(() => fetch(url));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return {
            translated: data[0].map(part => part[0]).join(""),
            detected: String(data[2] || "")
        };
    }

    async function translateText(text) {
        const target = settings.target;
        const key = cacheKey(text, target);

        if (cache.has(key)) return cache.get(key);
        if (inflight.has(key)) return inflight.get(key);
        if (Date.now() < blockedUntil) return null;

        // Nothing to translate (numbers, punctuation, emoji)
        if (!/\p{L}/u.test(text)) {
            cacheSet(key, null);
            return null;
        }

        const request = (async () => {
            try {
                let { translated, detected } = await gtxTitle(text, "auto", target);
                const d = detected.toLowerCase();
                const t = target.toLowerCase();

                let result;
                if (t.startsWith("zh") && d.startsWith("zh")) {
                    if (translated.trim() !== text.trim()) {
                        result = translated; // script was already converted, no 2nd call needed
                    } else {
                        const from = t === "zh-cn" ? "zh-TW" : "zh-CN";
                        ({ translated } = await gtxTitle(text, from, target));
                        result = translated;
                    }
                } else if (d === t || (!t.includes("-") && d.split("-")[0] === t)) {
                    result = null;
                } else {
                    result = translated;
                }

                if (result && result.trim().toLowerCase() === text.trim().toLowerCase()) result = null;

                failCount = 0;
                cacheSet(key, result);
                return result;
            } catch (err) {
                failCount++;
                const wait = Math.min(30000 * 2 ** (failCount - 1), 15 * 60 * 1000);
                blockedUntil = Date.now() + wait;
                console.error("Translation error:", err);
                Spicetify.showNotification(`Translation failed, pausing for ${Math.round(wait / 1000)}s`, true);
                return null;
            } finally {
                inflight.delete(key);
            }
        })();

        inflight.set(key, request);
        return request;
    }

    // DOM
    function getTitleElement() {
        return (
            document.querySelector('[data-testid="context-item-link"]') ||
            document.querySelector('[data-testid="nowplaying-track-link"]') ||
            document.querySelector(".main-trackInfo-name a")
        );
    }

    function formatTitle(translated, original) {
        return settings.display === "replace" ? translated : `${translated} (${original})`;
    }

    const manuallyTranslated = new Set();
    let lastApplied = null;

    function shouldApply(uri) {
        return settings.mode === "auto" || manuallyTranslated.has(uri);
    }

    function restoreTitle() {
        const title = Spicetify.Player.data?.item?.name;
        const el = getTitleElement();
        if (el && title && lastApplied && el.textContent === lastApplied) {
            el.textContent = title;
        }
        lastApplied = null;
    }

    async function applyTitle() {
        const item = Spicetify.Player.data?.item;
        const title = item?.name;
        const uri = item?.uri;
        if (!title || !shouldApply(uri)) return;

        const el = getTitleElement();
        if (!el || el.textContent.trim() !== title.trim()) return;

        const target = settings.target;

        if (!cache.has(cacheKey(title, target))) {
            await new Promise(r => setTimeout(r, NETWORK_DELAY));
            if (Spicetify.Player.data?.item?.uri !== uri) return;
        }

        const translated = await translateText(title);
        if (!translated) return;

        if (Spicetify.Player.data?.item?.uri !== uri) return;
        if (settings.target !== target) return;
        if (!shouldApply(uri)) return;
        if (el.textContent.trim() !== title.trim()) return;

        lastApplied = formatTitle(translated, title);
        el.textContent = lastApplied;
    }

    // Manual trigger
    async function translateCurrent() {
        const item = Spicetify.Player.data?.item;
        if (!item) return;

        manuallyTranslated.add(item.uri);
        restoreTitle();
        await applyTitle();

        if (cache.get(cacheKey(item.name)) === null) {
            Spicetify.showNotification(`Title is already in ${LANGUAGES[settings.target]}`);
        }
    }

    function refresh() {
        restoreTitle();
        setTimeout(applyTitle, 50);
    }

    // Select language
    function openLanguagePicker() {
        const wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;flex-direction:column;gap:12px;";

        const label = document.createElement("label");
        label.textContent = "Translate titles into:";
        label.style.cssText = "font-size:14px;";

        const select = document.createElement("select");
        select.style.cssText =
            "padding:8px;border-radius:4px;background:#282828;color:#fff;border:1px solid #535353;font-size:14px;";

        for (const [code, name] of Object.entries(LANGUAGES)) {
            const opt = document.createElement("option");
            opt.value = code;
            opt.textContent = name;
            if (code === settings.target) opt.selected = true;
            select.appendChild(opt);
        }

        select.addEventListener("change", () => {
            settings.target = select.value;
            saveSettings();
            syncMenu();
            refresh();
            Spicetify.showNotification(`Target language: ${LANGUAGES[settings.target]}`);
        });

        wrap.append(label, select);

        Spicetify.PopupModal.display({
            title: "Title Translator: Target language",
            content: wrap
        });
    }

    // Menu
    const autoItem = new Spicetify.Menu.Item("Auto translate", settings.mode === "auto", () => {
        settings.mode = "auto";
        saveSettings();
        syncMenu();
        refresh();
    });

    const manualItem = new Spicetify.Menu.Item("Manual translate", settings.mode === "manual", () => {
        settings.mode = "manual";
        manuallyTranslated.clear();
        saveSettings();
        syncMenu();
        refresh();
    });

    const bothItem = new Spicetify.Menu.Item("Show Translated (Original)", settings.display === "both", () => {
        settings.display = "both";
        saveSettings();
        syncMenu();
        refresh();
    });

    const replaceItem = new Spicetify.Menu.Item("Show translated only", settings.display === "replace", () => {
        settings.display = "replace";
        saveSettings();
        syncMenu();
        refresh();
    });

    const languageItem = new Spicetify.Menu.Item(
        `Target language: ${LANGUAGES[settings.target]}`,
        false,
        () => openLanguagePicker()
    );

    const translateNowItem = new Spicetify.Menu.Item("Translate current title", false, () => {
        translateCurrent();
    });

    function syncMenu() {
        autoItem.setState(settings.mode === "auto");
        manualItem.setState(settings.mode === "manual");
        bothItem.setState(settings.display === "both");
        replaceItem.setState(settings.display === "replace");
        try {
            languageItem.setName(`Target language: ${LANGUAGES[settings.target]}`);
        } catch {
        }
    }

    new Spicetify.Menu.SubMenu("Title Translator", [
        autoItem,
        manualItem,
        bothItem,
        replaceItem,
        languageItem,
        translateNowItem
    ]).register();

    // Playbar button 
    try {
        if (Spicetify.Playbar?.Button) {
            new Spicetify.Playbar.Button(
                "Translate title",
                '<path d="M1 2h14v2H9v10H7V4H1z"/>',
                () => {
                    if (settings.mode === "manual") {
                        translateCurrent();
                    } else {
                        Spicetify.showNotification("Switch to manual mode to translate on demand");
                    }
                }
            );
        }
    } catch (e) {
        console.warn("Could not add playbar button:", e);
    }

    // Events
    Spicetify.Player.addEventListener("songchange", () => {
        lastApplied = null;
        setTimeout(applyTitle, 300);
    });

    let timer;
    new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(applyTitle, 150);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });

    applyTitle();
    console.log("Translator extension loaded", settings);
})();
