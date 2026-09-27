import { useEffect, useState, useSyncExternalStore } from "react";
import { Dialog } from "./dialog";
export const themes = [
  { id: "system", name: "Follow system" },
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" },
  { id: "gruvbox-light", name: "Gruvbox Light" },
  { id: "gruvbox-dark", name: "Gruvbox Dark" },
  { id: "nord", name: "Nord" },
  { id: "catppuccin", name: "Catppuccin Mocha" },
  { id: "rose-pine", name: "Rosé Pine Dawn" },
  { id: "midnight", name: "Midnight" },
  { id: "plum", name: "Plum" },
  { id: "ocean", name: "Ocean" },
  { id: "sand", name: "Sand" },
  { id: "lavender", name: "Lavender" },
  { id: "ice", name: "Ice" },
  { id: "mint", name: "Mint" },
  { id: "blush", name: "Blush" },
  { id: "paper", name: "Paper" },
  { id: "ember", name: "Ember" },
  { id: "forest", name: "Forest" },
  { id: "graphite", name: "Graphite" },
  { id: "high-contrast-light", name: "High Contrast Light" },
  { id: "high-contrast-dark", name: "High Contrast Dark" },
];
const lightIds = new Set(["light", "gruvbox-light", "rose-pine", "sand", "lavender", "ice", "mint", "blush", "paper", "high-contrast-light"]);
const choicesFor = (mode: "light" | "dark") => themes.filter(t => t.id !== "system" && lightIds.has(t.id) === (mode === "light"));
function readSystemTheme(mode: "light" | "dark") {
  try {
    const value = localStorage.getItem("taskpath-theme-" + mode);
    if (choicesFor(mode).some(t => t.id === value)) return value!;
  } catch {}
  return mode;
}
export function ThemeDialog({ close }: { close: () => void }) {
  const [selected, setSelected] = useState(() => {
    try {
      return localStorage.getItem("taskpath-theme") || "system";
    } catch {
      return "system";
    }
  });
  const [pair, setPair] = useState(() => ({ light: readSystemTheme("light"), dark: readSystemTheme("dark") }));
  useEffect(() => {
    const update = () => {
      setPair({ light: readSystemTheme("light"), dark: readSystemTheme("dark") });
      try {
        setSelected(localStorage.getItem("taskpath-theme") || "system");
      } catch {}
    };
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, []);
  return (
    <Dialog id="theme-dialog" title="Choose theme" onClose={close}>
      {selected === "system" && (
        <fieldset className="system-theme-settings">
          <legend>Follow your device’s appearance</legend>
          <div className="system-theme-pair">
            {(["light", "dark"] as const).map(mode => (
              <label key={mode}>
                <span>{mode === "light" ? "Light mode" : "Dark mode"}</span>
                <select aria-label={mode === "light" ? "Theme for light mode" : "Theme for dark mode"}
                  value={pair[mode]}
                  onChange={event => {
                    const theme = event.target.value;
                    try { localStorage.setItem("taskpath-theme-" + mode, theme); } catch {}
                    setPair(current => ({ ...current, [mode]: theme }));
                    window.dispatchEvent(new CustomEvent("taskpath-system-themes", { detail: { mode, theme } }));
                  }}>
                  {choicesFor(mode).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
            ))}
          </div>
          <p>Switches automatically with your device. Saved in this browser.</p>
        </fieldset>
      )}
      <div id="theme-choices" className="theme-choices">
        {themes.map((t) => (
          <button
            key={t.id}
            type="button"
            className="theme-choice"
            aria-pressed={selected === t.id}
            onClick={() => {
              try {
                if (t.id === "system")
                  localStorage.removeItem("taskpath-theme");
                else localStorage.setItem("taskpath-theme", t.id);
              } catch {}
              setSelected(t.id);
              window.dispatchEvent(
                new CustomEvent("taskpath-theme", { detail: t.id }),
              );
            }}
          >
            <span
              className={
                "theme-preview" + (t.id === "system" ? " theme-system" : "")
              }
            >
              {t.id === "system" ? (
                "◐"
              ) : (
                <img
                  src={`/assets/__TASKPATH_RELEASE__/themes/${t.id}/favicon.svg`}
                  width={32}
                  height={32}
                  alt=""
                />
              )}
            </span>
            <span>{t.name}</span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}

const themeSnapshot = () => document.documentElement.dataset.theme || "light";
const themeSubscription = (notify: () => void) => {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
};
export function ThemeIcon() {
  const theme = useSyncExternalStore(themeSubscription, themeSnapshot);
  return (
    <img
      src={`/assets/__TASKPATH_RELEASE__/themes/${theme}/favicon.svg`}
      width={24}
      height={24}
      alt=""
    />
  );
}
