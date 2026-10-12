import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  // A visible folder (not .output) so it's easy to find with Load unpacked.
  outDir: 'extension',
  manifest: {
    name: 'FlowSnap',
    description: 'Record a user flow as you click through a site, then see it as a diagram.',
    // No website access at install. It's requested on the first recording.
    permissions: ['activeTab', 'scripting', 'storage', 'unlimitedStorage'],
    optional_host_permissions: ['<all_urls>'],
    action: { default_title: 'FlowSnap: click to start recording' },
  },
  hooks: {
    // WXT adds the content script's matches as install-time host permissions.
    // FlowSnap injects it itself after access is granted, so remove them.
    'build:manifestGenerated': (_wxt, manifest) => {
      delete manifest.host_permissions;
    },
  },
});
