# Delisted & Region-Locked Games - Restore Images

A [Millennium](https://steambrew.app) plugin for the Steam desktop client.

Steam hides the images of games that were removed from the store or are unavailable in your region — even if you
own them. Instead of game covers you see empty boxes and grey placeholders.

This plugin brings the original images back on Steam Community profile pages:

- Profile showcases
- Game list
- Game achievement pages

Just install it — no settings needed. It doesn't collect any data: the only requests it makes are for game
images on the official Steam CDN.

Using Chrome? The same fix is available as a Chrome extension (link coming soon).

## Building

Requires [Millennium](https://github.com/SteamClientHomebrew/Millennium) >= 3.4.0 and [Bun](https://bun.com/) >= 1.0.

```bash
bun install
bun run build
```

The build installs the plugin into your Millennium installation. Enable it in Millennium → Plugins and restart Steam.

## License

MIT

Not affiliated with Valve or Steam.
