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
];
export function ThemeDialog({ close }: { close: () => void }) {
  const [selected, setSelected] = useState(() => {
    try {
      return localStorage.getItem("taskpath-theme") || "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    const update = () => {
      try {
        setSelected(localStorage.getItem("taskpath-theme") || "system");
      } catch {}
    };
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, []);
  return (
    <Dialog id="theme-dialog" title="Choose theme" onClose={close}>
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
