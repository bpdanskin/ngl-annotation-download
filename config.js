// Deployment auth config.
//
// For a PUBLIC deployment (e.g. GitHub Pages) where you don't want users to
// manage auth, paste a service-account middleauth token below. It will be used
// as the default token for everyone who loads the page.
//
//   WARNING: This file is served publicly. Anyone can read this token and use
//   it as that service account. Only ever put a token here that is scoped to
//   PUBLIC / read-only permissions, and prefer a dedicated service account you
//   can rotate and monitor.
//
// For LOCAL testing with your own personal token, DON'T edit this file. Instead
// paste your token into the "Auth token" field in the app; it is stored only in
// your browser's localStorage and takes precedence over the value here.
window.NGL_CONFIG = {
  // Public, read-only service-account token for the default deployment.
  token: "a549b45f5f69c48cf6becaba42392595",
  // Optional: override the login URL shown to users who need a token.
  tokenHelpUrl: "https://global.daf-apis.com/sticky_auth/api/v1/create_token",
};
