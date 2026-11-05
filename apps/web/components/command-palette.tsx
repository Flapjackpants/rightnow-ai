"use client";

import { Moon, Plus, Search, Upload, type LucideIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { NAV } from "../lib/nav";
import { cn } from "../lib/utils";

type Item = {
  id: string;
  label: string;
  icon: LucideIcon;
  group: "Go to" | "Actions";
  href?: string;
};

const SUB: { href: string; label: string; parent: string }[] = [
  { href: "/scheduled", label: "Scheduled emails", parent: "/campaigns" },
  { href: "/leads/lists", label: "Lead lists", parent: "/leads" },
  { href: "/blocklist", label: "Blocklist", parent: "/leads" },
  { href: "/deliverability/placement", label: "Inbox placement", parent: "/deliverability" },
  { href: "/settings/api-keys", label: "API keys", parent: "/settings" },
  { href: "/settings/lead-sources", label: "Lead sources", parent: "/settings" },
];
export const ITEMS: Item[] = [
  ...NAV.map((n) => ({
    id: n.href,
    label: n.label,
    icon: n.icon,
    group: "Go to" as const,
    href: n.href,
  })),
  ...SUB.map((s) => ({
    id: s.href,
    label: s.label,
    icon: NAV.find((n) => n.href === s.parent)!.icon,
    group: "Go to" as const,
    href: s.href,
  })),
  {
    id: "a-connect",
    label: "Connect an email account",
    icon: Plus,
    group: "Actions",
    href: "/accounts",
  },
  { id: "a-import", label: "Import leads", icon: Upload, group: "Actions", href: "/leads" },
  {
    id: "a-campaign",
    label: "Create a campaign",
    icon: Plus,
    group: "Actions",
    href: "/campaigns",
  },
  { id: "a-theme", label: "Toggle dark mode", icon: Moon, group: "Actions" },
];

/** Case-insensitive substring match on labels (B3.4). */
export const filterItems = (q: string) => {
  const n = q.trim().toLowerCase();
  return n ? ITEMS.filter((i) => i.label.toLowerCase().includes(n)) : ITEMS;
};

export const isMac = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * B3.4 command palette: Cmd/Ctrl+K anywhere, or `open()` from a trigger. Native modal dialog (focus trap, Escape),
 * a combobox input over a listbox (aria-activedescendant), Up/Down/Enter.
 */
export function useCommandPalette() {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const d = ref.current;
        if (d?.open) d.close();
        else d?.showModal();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return { ref, open: () => ref.current?.showModal() };
}

export function CommandPalette({
  dialogRef,
}: {
  dialogRef: React.RefObject<HTMLDialogElement | null>;
}) {
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const items = filterItems(q);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function run(i: Item | undefined) {
    if (!i) return;
    dialogRef.current?.close();
    if (i.href) router.push(i.href);
    else setTheme(resolvedTheme === "dark" ? "light" : "dark");
  }
  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (items.length ? (a + d + items.length) % items.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(items[active]);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-label="Command palette"
      onClose={() => {
        setQ("");
        setActive(0);
      }}
      className="m-0 h-dvh max-h-dvh w-screen max-w-none overflow-hidden bg-elevated text-fg shadow-e3 open:animate-pop md:mx-auto md:mt-[12vh] md:h-auto md:max-h-[70vh] md:w-160 md:rounded-xl"
    >
      <div className="flex h-13 items-center gap-2.5 border-b border-border px-4">
        <Search className="size-4 shrink-0 text-fg-muted" aria-hidden />
        <input
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={items[active] ? `palette-${items[active].id}` : undefined}
          aria-label="Search pages and actions"
          placeholder="Type a page or action..."
          autoComplete="off"
          className="h-full flex-1 bg-transparent text-base outline-none"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKey}
        />
        <kbd className="rounded-xs border border-border bg-sunken px-1.5 font-mono text-[11px]/4 font-medium text-fg-muted">
          Esc
        </kbd>
      </div>
      {items.length === 0 ? (
        <p className="px-4 py-6 text-[13px]/[18px] text-fg-muted">
          No page or action matches &quot;{q}&quot;.
        </p>
      ) : (
        <div
          ref={list}
          id="palette-list"
          role="listbox"
          aria-label="Pages and actions"
          className="max-h-[calc(100dvh-52px)] overflow-y-auto p-1.5 md:max-h-[calc(70vh-52px)]"
        >
          {(["Go to", "Actions"] as const).map((g) =>
            items.some((i) => i.group === g) ? (
              <div key={g} role="group" aria-labelledby={`palette-g-${g.replace(" ", "")}`}>
                <p
                  id={`palette-g-${g.replace(" ", "")}`}
                  className="micro px-2.5 pt-3 pb-1 text-fg-subtle"
                >
                  {g}
                </p>
                {items.map((i, n) =>
                  i.group === g ? (
                    <div
                      key={i.id}
                      id={`palette-${i.id}`}
                      role="option"
                      aria-selected={n === active}
                      onMouseMove={() => setActive(n)}
                      onClick={() => run(i)}
                      className={cn(
                        "flex h-10 cursor-pointer items-center gap-2.5 rounded-sm px-2.5 text-sm",
                        n === active && "bg-signal-tint",
                      )}
                    >
                      <i.icon className="size-4 text-fg-muted" aria-hidden />
                      <span className="flex-1">{i.label}</span>
                      {i.href && (
                        <span className="text-[13px]/[18px] text-fg-subtle">{i.href}</span>
                      )}
                    </div>
                  ) : null,
                )}
              </div>
            ) : null,
          )}
        </div>
      )}
    </dialog>
  );
}
