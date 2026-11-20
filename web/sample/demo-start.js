// Starting at #/ preserves the real launcher-to-Finances interaction.
if (!location.hash) history.replaceState(null, '', '#/');
await import('./launcher.js');
