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
    };

    // Settings 
    const STORAGE_KEY = "translator:settings";
    const defaults = {
        mode: "auto",
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
    const cache = new Map(); // `${target}|${original}` -> translated string, or null if no translation needed

    const cacheKey = (text, target = settings.target) => `${target}|${text}`;

    async function translateText(text) {
        const target = settings.target;
        const key = cacheKey(text, target);
        if (cache.has(key)) return cache.get(key);

        try {
            const url =
                "https://translate.googleapis.com/translate_a/single" +
                `?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
            const res = await fetch(url);
            const data = await res.json();

            const translated = data[0].map(part => part[0]).join("");
            const detected = String(data[2] || "").toLowerCase();
            const targetLower = target.toLowerCase();

            const sameLang =
                detected === targetLower ||
                (!targetLower.includes("-") && detected.split("-")[0] === targetLower);

            const result =
                sameLang || translated.trim().toLowerCase() === text.trim().toLowerCase()
                    ? null
                    : translated;

            cache.set(key, result);
            return result;
        } catch (err) {
            console.error("Translation error:", err);
            return null;
        }
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
