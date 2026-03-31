(() => {
    const CACHE = new Map();
    const TARGET_LANG = "en"; // change to desired language
    const PUBLIC_LIBRE_URL = "https://translate.argosopentech.com/translate";

    /**
     * Try to detect local LibreTranslate
     */
    async function hasLocalLibreTranslate() {
        try {
            const r = await fetch("http://localhost:5000/languages");
            return r.ok;
        } catch {
            return false;
        }
    }

    /**
     * Translate using a given endpoint
     */
    async function translateWithUrl(text, targetLang, url) {
        const body = {
            q: text,
            source: "auto",
            target: targetLang,
            format: "text"
        };
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });

        if (!res.ok) throw new Error(`Translation failed: ${res.status}`);
        const data = await res.json();
        return data.translatedText;
    }

    /**
     * Cached translation function
     */
    async function translateCached(text) {
        const key = `${text}:${TARGET_LANG}`;
        if (CACHE.has(key)) return CACHE.get(key);

        let url = PUBLIC_LIBRE_URL;
        if (await hasLocalLibreTranslate()) url = "http://localhost:5000/translate";

        try {
            const translated = await translateWithUrl(text, TARGET_LANG, url);
            CACHE.set(key, translated);
            return translated;
        } catch (err) {
            console.error("Translation error:", err);
            return text; // fallback: return original
        }
    }

    /**
     * Replace the song title in the UI
     */
    async function updateTitleUI() {
        const track = Spicetify.Player.data?.item;
        if (!track) return;

        const originalTitle = track.name;
        const translatedTitle = await translateCached(originalTitle);

        // Only update if different
        if (originalTitle !== translatedTitle) {
            const titleElem = document.querySelector(".track-info__name a, .main-trackInfo-name a");
            if (titleElem) titleElem.textContent = translatedTitle;
        }
    }

    /**
     * Listen for track changes
     */
    function setupTrackChangeListener() {
        Spicetify.Player.addEventListener("songchange", updateTitleUI);
    }

    /**
     * Settings toggle (optional)
     */
    function addSettingsToggle() {
        const settings = document.querySelector(".settings-menu");
        if (!settings) return;

        const toggle = document.createElement("div");
        toggle.innerHTML = `
            <label style="display:flex;align-items:center;gap:8px">
                <input type="checkbox" id="translateToggle" checked />
                Translate song titles
            </label>
        `;
        settings.appendChild(toggle);

        const checkbox = toggle.querySelector("#translateToggle");
        checkbox.addEventListener("change", () => {
            if (checkbox.checked) updateTitleUI();
        });
    }

    /**
     * Initialization
     */
    function init() {
        setupTrackChangeListener();
        updateTitleUI(); // translate current track
        addSettingsToggle();
        console.log("Spicetify Song Title Translator loaded!");
    }

    // Wait for Spicetify to be ready
    if (Spicetify?.Player) {
        init();
    } else {
        document.addEventListener("spicetify-loaded", init);
    }
})();
