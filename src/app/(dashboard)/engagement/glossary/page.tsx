"use client";

// Glossary — plain-language meaning of every term used in the LuLu engagement screens.

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Search } from "lucide-react";
import { GLOSSARY, type Term } from "./terms";

const norm = (s: string) => s.toLowerCase();
const matches = (t: Term, q: string) =>
  !q || [t.term, t.meaning, t.example ?? "", ...(t.aka ?? [])].some((x) => norm(x).includes(q));

export default function GlossaryPage() {
  const [q, setQ] = useState("");
  const query = norm(q.trim());
  const sections = useMemo(
    () => GLOSSARY.map((s) => ({ ...s, terms: s.terms.filter((t) => matches(t, query)) })).filter((s) => s.terms.length > 0),
    [query],
  );
  const total = sections.reduce((a, s) => a + s.terms.length, 0);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <div>
        <Link href="/engagement" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3 w-3" /> Engagement
        </Link>
        <h1 className="text-xl font-semibold text-foreground">Glossary</h1>
        <p className="text-sm text-muted-foreground">
          What every term in the engagement screens means, with the exact rule and an example. Numbers are the current default settings.
        </p>
      </div>

      <div className="sticky top-0 z-10 -mx-1 space-y-2 bg-background/95 px-1 py-2 backdrop-blur">
        <div className="relative">
          <Search className="absolute start-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search a term, e.g. dormant, lift, STOP, VIP…"
            className="w-full rounded-lg border border-border bg-background py-2 pe-3 ps-9 text-sm text-foreground"
          />
        </div>
        {!query && (
          <nav className="flex flex-wrap gap-1">
            {GLOSSARY.map((s) => (
              <a key={s.id} href={`#${s.id}`} className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
                {s.title}
              </a>
            ))}
          </nav>
        )}
        {query && <p className="text-xs text-muted-foreground">{total} matching {total === 1 ? "term" : "terms"}</p>}
      </div>

      {sections.map((s) => (
        <section key={s.id} id={s.id} className="scroll-mt-28 space-y-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">{s.title}</h2>
            {s.intro && !query && <p className="mt-0.5 text-sm text-muted-foreground">{s.intro}</p>}
          </div>
          <div className="divide-y divide-border rounded-xl border border-border bg-card">
            {s.terms.map((t) => (
              <div key={t.term} className="grid gap-1 p-4 md:grid-cols-[14rem_1fr] md:gap-4">
                <div>
                  <div className="font-medium text-foreground">{t.term}</div>
                  {t.aka && t.aka.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {t.aka.map((a) => (
                        <span key={a} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                          {a}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="space-y-1.5 text-sm">
                  <p className="text-foreground">{t.meaning}</p>
                  {t.example && (
                    <p className="rounded-md border-s-2 border-primary/60 bg-muted/40 px-3 py-1.5 text-muted-foreground">
                      <span className="font-medium text-foreground">Example: </span>
                      {t.example}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

      {sections.length === 0 && <p className="text-sm text-muted-foreground">No term matches “{q}”.</p>}
    </div>
  );
}
