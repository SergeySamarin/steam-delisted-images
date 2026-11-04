import { definePlugin, Field } from 'millennium';

// The plugin does all its work in webview/preload.ts.
// The frontend only provides an entry in Millennium settings.

const SettingsContent = () => (
  <Field label="Restores missing images of delisted and region-locked games on Steam profile pages. No settings needed." />
);

export default definePlugin(() => ({
  title: 'Delisted & Region-Locked Games',
  icon: <span />,
  content: <SettingsContent />,
}));
