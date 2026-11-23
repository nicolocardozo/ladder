"use client";

// Menu della nav su mobile: niente sidebar, una tendina che scende dalla pillola dell'header
// con i link, l'interruttore del tema e la lista d'attesa. Si chiude con un link, Esc, un tocco fuori
// o cambiando pagina. Con movimento ridotto appare senza animazione.
import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight, Moon, Sun } from "lucide-react";
import { setTheme, useTheme } from "@/lib/theme";
import { CTA } from "@/lib/site";
import { cn } from "@/lib/utils";
import { DownloadLink } from "@/components/download-link";

type NavLink = { href: string; label: string };

// Il pannello sta fuori dalla pillola: il backdrop-filter della pillola farebbe da contenitore
// agli elementi fixed/absolute, quindi la pillola la riceve come classe e il pannello è fratello.
export function MobileMenu({
  links,
  pillClassName,
}: {
  links: readonly NavLink[];
  pillClassName: string;
}) {
  const [open, setOpen] = useState(false);
  const [lastPath, setLastPath] = useState<string | null>(null);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const theme = useTheme();

  // cambiando pagina il menu si chiude (stato derivato durante il render, senza effetto)
  if (pathname !== lastPath) {
    setLastPath(pathname);
    if (open) setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    panel.current
      ?.querySelector<HTMLElement>("a,button")
      ?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t))
        setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const close = () => setOpen(false);
  const nextTheme = theme === "dark" ? "light" : "dark";

  return (
    <>
      <div className={pillClassName}>
        <button
          ref={button}
          type="button"
          aria-expanded={open}
          aria-controls={id}
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((v) => !v)}
          className="relative inline-flex size-[34px] items-center justify-center rounded-[9px] text-ink transition-colors hover:bg-frame/80"
        >
          {/* due linee che diventano una X */}
          <span aria-hidden className="relative block h-3 w-4">
            <span
              className={cn(
                "absolute inset-x-0 h-[1.5px] rounded-full bg-current transition-transform duration-300 ease-[cubic-bezier(0.2,0.9,0.2,1)] motion-reduce:transition-none",
                open ? "top-[5px] rotate-45" : "top-[2px]",
              )}
            />
            <span
              className={cn(
                "absolute inset-x-0 h-[1.5px] rounded-full bg-current transition-transform duration-300 ease-[cubic-bezier(0.2,0.9,0.2,1)] motion-reduce:transition-none",
                open ? "top-[5px] -rotate-45" : "top-[8px]",
              )}
            />
          </span>
        </button>
      </div>

      {/* Velo leggero sotto la tendina */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none fixed inset-0 -z-10 bg-page/40 md:hidden backdrop-blur-[2px] transition-opacity duration-300 motion-reduce:transition-none",
          open ? "opacity-100" : "opacity-0",
        )}
      />

      <div
        ref={panel}
        id={id}
        inert={!open}
        className={cn(
          "pointer-events-auto absolute inset-x-5 top-[calc(100%+8px)] sm:inset-x-7 md:hidden origin-top-right overflow-hidden rounded-[18px] border border-hairline bg-page/90 p-2 shadow-[0_24px_60px_-12px_rgb(24_20_36/0.28)] backdrop-blur-[18px] backdrop-saturate-150",
          "transition-[opacity,transform,clip-path] duration-[420ms] ease-[cubic-bezier(0.2,0.9,0.2,1)] motion-reduce:transition-none",
          open
            ? "visible translate-y-0 scale-100 opacity-100 [clip-path:inset(0_0_0_0_round_18px)]"
            : "invisible -translate-y-1 scale-[0.96] opacity-0 [clip-path:inset(0_0_100%_30%_round_18px)]",
        )}
      >
        <nav aria-label="Main">
          <ul>
            {links.map((l, i) => (
              <li
                key={l.href}
                style={{ transitionDelay: open ? `${80 + i * 40}ms` : "0ms" }}
                className={cn(
                  "transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none",
                  open
                    ? "translate-y-0 opacity-100"
                    : "-translate-y-1.5 opacity-0",
                )}
              >
                <Link
                  href={l.href}
                  onClick={close}
                  className="flex h-12 items-center justify-between rounded-[12px] px-4 text-[17px] font-medium text-ink transition-colors hover:bg-frame active:bg-frame"
                >
                  {l.label}
                  <ArrowRight aria-hidden className="size-4 text-muted-ink" />
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div
          style={{
            transitionDelay: open ? `${80 + links.length * 40}ms` : "0ms",
          }}
          className={cn(
            "mt-2 flex items-center gap-2 border-t border-hairline px-1 pt-3 pb-1 transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none",
            open ? "translate-y-0 opacity-100" : "-translate-y-1.5 opacity-0",
          )}
        >
          <button
            type="button"
            onClick={() => setTheme(nextTheme)}
            aria-label={
              nextTheme === "dark"
                ? "Switch to dark theme"
                : "Switch to light theme"
            }
            className="inline-flex h-12 flex-none items-center gap-2 rounded-[12px] border border-hairline px-4 text-[15px] font-medium text-ink transition-colors hover:bg-frame"
          >
            {theme === "dark" ? (
              <Sun aria-hidden className="size-4" />
            ) : (
              <Moon aria-hidden className="size-4" />
            )}
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          <DownloadLink
            onClick={close}
            className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-[12px] bg-ink px-4 text-[15px] font-medium text-page transition-colors hover:bg-ink/85"
          >
            {CTA.label}
          </DownloadLink>
        </div>
      </div>
    </>
  );
}
