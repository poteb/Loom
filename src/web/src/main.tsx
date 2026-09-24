import { render } from "preact";
import { LoomClient } from "@loom/client";
import { App } from "./app.js";
import { browserStorage } from "./storage.js";
import { createPersistenceNotice } from "./persistence.js";
import { createWeavesSignal } from "./weaves-signal.js";
// IBM Plex, self-hosted: Vite bundles the woff2 files into `assets/`, so no visitor request goes to
// Google. Only the weights the stylesheet uses; each file carries every subset behind a
// `unicode-range`, so a browser fetches only the subsets a page actually draws.
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles.css";

// The one storage instance in the package (spec §2.4a). Every session, form and list shares it, so
// a credential that could only be written to memory is still there after an in-place transition.
// The signal is its companion: one per page, handed to everyone who is handed the store, so a write
// here shows up in the list there (spec §4.2).
render(
  <App
    client={new LoomClient({ baseUrl: location.origin, allowInsecure: location.protocol === "http:" })}
    storage={browserStorage()}
    notice={createPersistenceNotice()}
    weaves={createWeavesSignal()}
  />,
  document.getElementById("app")!,
);
