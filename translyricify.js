(async function () {
    while (!window.Spicetify || !Spicetify.Player || !Spicetify.Player.data || !Spicetify.Menu) {
        await new Promise(r => setTimeout(r, 100));
    }

    // Settings
    const STORAGE_KEY = "lyricsConverter:settings";
    const defaults = {
        romanize: "below"
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
    async function gtx(q, sl) {
        const url =
            "https://translate.googleapis.com/translate_a/single" +
            `?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(sl === "auto" ? "en" : sl)}&dt=t&dt=rm`;

        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
            },
            body: "q=" + encodeURIComponent(q)
        });

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
        const rom = data.rom ? data.rom.split("\n") : null;

        if (rom && rom.length === lines.length) {
            return {
                lang: data.lang,
                results: lines.map((_, i) => ({
                    rom: rom[i].trim() || null
                }))
            };
        }

        console.warn("Lyrics Converter: batch misaligned, falling back to per-line requests");

        const results = new Array(lines.length);

        for (let i = 0; i < lines.length; i += 4) {
            await Promise.all(
                lines.slice(i, i + 4).map(async (t, k) => {
                    const d = await gtx(clean(t), data.lang || sl);
                    results[i + k] = {
                        rom: d.rom ? d.rom.trim() : null
                    };
                })
            );
        }

        return {
            lang: data.lang,
            results
        };
    }

    const cache = new Map();
    const pending = new Set();
    let cooldownUntil = 0;

    async function fetchMissing(texts) {
        texts.forEach(t => pending.add(t));

        try {
            let sl = "auto";

            for (let i = 0; i < texts.length; i += CHUNK_SIZE) {
                const chunk = texts.slice(i, i + CHUNK_SIZE);
                const { results, lang } = await convertChunk(chunk, sl);

                if (lang && sl === "auto") sl = lang;

                chunk.forEach((t, j) => cache.set(t, results[j]));
            }
        } catch (err) {
            console.error("Lyrics Converter error:", err);
            cooldownUntil = Date.now() + 30000;
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
        const missing = new Set();

        for (const el of getLineElements()) {
            const text = el.textContent;
            const existing = records.get(el);

            // Still showing what we wrote: nothing to do.
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
                missing.add(text);
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

        if (missing.size && Date.now() >= cooldownUntil) {
            fetchMissing([...missing]).then(() => scan());
        }
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
