import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { initHrlI18n } from "./lib/hrl/hrl-i18n";
import { PAIRS } from "./lib/hrl/dict";

// English is the main language; Polish via the switcher, ?lang=pl or the shared hrl_lang cookie.
initHrlI18n({ pairs: PAIRS, storageKey: "mp_lang" });

createRoot(document.getElementById("root")!).render(<App />);
