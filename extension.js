(function init() {
	if (!Spicetify.Player || !Spicetify.Platform) {
		setTimeout(init, 100);
		return;
	}

	main();
})();

function main() {
	// Top Bar
	const button = new Spicetify.Topbar.Button(
		"My Button",
		`<svg>...</svg>`,  // SVG icon
		() => {
			console.log("Button clicked!");
		}
	);

	// Context Menu Item
	new Spicetify.ContextMenu.Item(
		"My Menu Item",
		(uris) => {
			console.log("Selected URIs:", uris);
		},
		(uris) => {
			// Return true to show this item
			return true;
		},
		`<svg>...</svg>`  // Optional icon
	).register();

	// GET request
	const response = await Spicetify.CosmosAsync.get(
		"https://api.spotify.com/v1/me/player"
	);

	// POST request
	await Spicetify.CosmosAsync.post(
		"https://api.spotify.com/v1/me/player/play",
		{ uris: ["spotify:track:..."] }
	);

	// Save
	Spicetify.LocalStorage.set("myExtension:setting", "value");

	// Load
	const value = Spicetify.LocalStorage.get("myExtension:setting");

	// Notification
	Spicetify.showNotification("Hello from my extension!");
}
