(async function() {
    while (!window.Spicetify || !Spicetify.Player || !Spicetify.Player.data || !Spicetify.Menu) {
        await new Promise(r => setTimeout(r, 100));
    }

    // Settings
    const STORAGE_KEY = "lyricsConverter:settings";
    const defaults = {
        romanize: "off"
    };

    function loadSettings() {
        try {
            const s = { ...defaults, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
            if (!["off", "below", "replace"].includes(s.romanize)) {
                s.romanize = defaults.romanize;
            }
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

    // Helpers
    const CHUNK_SIZE = 30;
    const NON_ASCII = /[^\x00-\x7F]/;
    const HAS_LETTER = /\p{L}/u;
    const needsConversion = t => NON_ASCII.test(t) && HAS_LETTER.test(t);
    const clean = t => t.replace(/\s*\n\s*/g, " ").trim();

    // Romanization
    const CACHE_KEY = "lyricsConverter:cache:v1";
    const MAX_CACHE = 5000;
    const FETCH_DELAY = 800; // ms to wait before calling the API (lets you skip tracks freely)
    const MIN_GAP = 500;     // min ms between requests

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

    async function gtx(q, sl) {
        const url =
            "https://translate.googleapis.com/translate_a/single" +
            `?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(sl === "auto" ? "en" : sl)}&dt=t&dt=rm`;

        const res = await throttled(() => fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
            },
            body: "q=" + encodeURIComponent(q)
        }));

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        const segs = Array.isArray(data[0]) ? data[0] : [];

        const romSeg = segs.find(s => s[0] == null && typeof s[3] === "string");

        return {
            rom: romSeg ? romSeg[3] : null,
            lang: String(data[2] || "")
        };
    }

    async function convertChunk(lines, sl) {
        const data = await gtx(lines.map(clean).join("\n"), sl);

        // No romanization offered for this text: retrying per line won't help
        if (!data.rom) {
            return { lang: data.lang, results: lines.map(() => ({ rom: null })) };
        }

        const rom = data.rom.split("\n");

        if (rom.length === lines.length) {
            return {
                lang: data.lang,
                results: lines.map((_, i) => ({ rom: rom[i].trim() || null }))
            };
        }

        if (lines.length === 1) {
            return { lang: data.lang, results: [{ rom: data.rom.trim() || null }] };
        }

        // Misaligned: split in halves instead of going line by line
        console.warn("Lyrics Converter: batch misaligned, splitting");
        const mid = Math.ceil(lines.length / 2);
        const lang = data.lang || sl;
        const a = await convertChunk(lines.slice(0, mid), lang);
        const b = await convertChunk(lines.slice(mid), lang);
        return { lang: data.lang, results: [...a.results, ...b.results] };
    }

    const pending = new Set();
    let cooldownUntil = 0;
    let failCount = 0;

    async function fetchMissing(texts) {
        texts.forEach(t => pending.add(t));

        try {
            let sl = "auto";

            for (let i = 0; i < texts.length; i += CHUNK_SIZE) {
                const chunk = texts.slice(i, i + CHUNK_SIZE);
                const { results, lang } = await convertChunk(chunk, sl);

                if (lang && sl === "auto") sl = lang;

                chunk.forEach((t, j) => cacheSet(t, results[j]));
            }

            failCount = 0;
        } catch (err) {
            failCount++;
            const wait = Math.min(30000 * 2 ** (failCount - 1), 15 * 60 * 1000);
            cooldownUntil = Date.now() + wait;
            console.error(`Lyrics Converter error, pausing for ${Math.round(wait / 1000)}s:`, err);
        } finally {
            texts.forEach(t => pending.delete(t));
        }
    }
    // DOM
    const LINE_SELECTORS = [
        '[data-testid="fullscreen-lyric"]',
        '[data-testid="lyrics-line"]',
        ".lyrics-lyricsContent-element",
        ".lyrics-lyricsContent-lyric",
        ".lyrics-lyricsContainer-LyricsLine"
    ].join(",");

    function getLineElements() {
        const all = Array.from(document.querySelectorAll(LINE_SELECTORS));

        // Keep only the innermost matches so wrappers aren't processed too.
        return all.filter(el => !all.some(o => o !== el && el.contains(o)));
    }

    function setText(el, str) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const nodes = [];

        while (walker.nextNode()) nodes.push(walker.currentNode);

        if (nodes.length === 1) {
            nodes[0].nodeValue = str;
        } else {
            el.textContent = str;
        }
    }

    // Element -> { original, output, styled }
    const records = new Map();
    let fetchTimer = null;
    let fetching = false;

    function scheduleFetch() {
        if (fetchTimer || fetching) return;
        fetchTimer = setTimeout(runFetch, FETCH_DELAY);
    }

    async function runFetch() {
        fetchTimer = null;
        if (settings.romanize === "off") return;

        // Still backing off after a failure: try again once it ends
        if (Date.now() < cooldownUntil) {
            fetchTimer = setTimeout(runFetch, cooldownUntil - Date.now() + 100);
            return;
        }

        // Only fetch lines that are still on screen
        const missing = new Set();
        for (const [el, rec] of records) {
            const t = rec.original;
            if (el.isConnected && needsConversion(t) && !cache.has(t) && !pending.has(t)) {
                missing.add(t);
            }
        }
        if (!missing.size) return;

        fetching = true;
        try { await fetchMissing([...missing]); }
        finally { fetching = false; }

        scan();
    }
    function renderFor(text) {
        const entry = cache.get(text);
        if (!entry || !entry.rom) return null;

        let out = text;

        if (settings.romanize === "below" && entry.rom !== text) {
            out = `${text}\n${entry.rom}`;
        } else if (settings.romanize === "replace") {
            out = entry.rom;
        }

        return out === text ? null : out;
    }

    function restoreAll() {
        for (const [el, rec] of records) {
            if (rec.output !== null && el.textContent === rec.output) {
                setText(el, rec.original);
            }

            if (rec.styled) el.style.whiteSpace = "";

            rec.output = null;
            rec.styled = false;
        }
    }

    function scan() {
        for (const el of records.keys()) {
            if (!el.isConnected) records.delete(el);
        }

        const enabled = settings.romanize !== "off";
        let needFetch = false;

        for (const el of getLineElements()) {
            const text = el.textContent;
            const existing = records.get(el);

            if (existing && existing.output !== null && text === existing.output) continue;
            if (!text.trim()) continue;

            const rec = {
                original: text,
                output: null,
                styled: false
            };

            records.set(el, rec);

            if (!enabled) continue;

            if (needsConversion(text) && !cache.has(text) && !pending.has(text)) {
                needFetch = true;
            }

            const out = renderFor(text);

            if (out) {
                rec.output = out;
                setText(el, out);

                if (out.includes("\n")) {
                    el.style.whiteSpace = "pre-line";
                    rec.styled = true;
                }
            }
        }

        if (needFetch) scheduleFetch();
    }

    function refresh() {
        restoreAll();
        scan();
    }

    // Menu
    function setRomanize(value) {
        settings.romanize = value;
        saveSettings();
        syncMenu();
        refresh();
    }

    const romOffItem = new Spicetify.Menu.Item(
        "Romanization: off",
        settings.romanize === "off",
        () => setRomanize("off")
    );

    const romBelowItem = new Spicetify.Menu.Item(
        "Romanization: below original",
        settings.romanize === "below",
        () => setRomanize("below")
    );

    const romReplaceItem = new Spicetify.Menu.Item(
        "Romanization: replace original",
        settings.romanize === "replace",
        () => setRomanize("replace")
    );

    function syncMenu() {
        romOffItem.setState(settings.romanize === "off");
        romBelowItem.setState(settings.romanize === "below");
        romReplaceItem.setState(settings.romanize === "replace");
    }

    new Spicetify.Menu.SubMenu("Lyrics Romanizer", [
        romOffItem,
        romBelowItem,
        romReplaceItem
    ]).register();

    // Events
    Spicetify.Player.addEventListener("songchange", () => {
        setTimeout(scan, 500);
        setTimeout(scan, 1500);
    });

    let timer;

    new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(scan, 200);
    }).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
    });

    scan();
    console.log("Lyrics Romanizer loaded", settings);
})();
