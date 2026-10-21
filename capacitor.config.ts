import type { CapacitorConfig } from '@capacitor/cli';
const config: CapacitorConfig = {
  appId: 'app.notenest.notes',
  appName: 'NoteNest',
  webDir: 'dist',
  bundledWebRuntime: false,
  android: { allowMixedContent: false }
};
export default config;