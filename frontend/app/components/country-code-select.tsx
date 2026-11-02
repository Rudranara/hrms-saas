"use client";
import { useEffect, useRef, useState, type KeyboardEvent, type ComponentType, type SVGProps } from "react";
import { getCountries, getCountryCallingCode, type CountryCode } from "libphonenumber-js/min";
import * as countryFlags from "country-flag-icons/react/3x2";

const flags = countryFlags as Record<CountryCode, ComponentType<SVGProps<SVGSVGElement>>>;
const names = new Intl.DisplayNames(["en"], { type: "region" });
const countries = getCountries().map((country) => ({ country, name: names.of(country) || country, code: `+${getCountryCallingCode(country)}` })).sort((a, b) => a.name.localeCompare(b.name, "en"));

export function CountryCodeSelect({ error }: { error?: string }) {
  const [country, setCountry] = useState<CountryCode>("IN"), [open, setOpen] = useState(false), [search, setSearch] = useState("");
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), searchInput = useRef<HTMLInputElement>(null);
  const Flag = flags[country], code = `+${getCountryCallingCode(country)}`;
  const query = search.trim().toLowerCase();
  const matches = countries.filter((item) => `${item.name} ${item.country} ${item.code}`.toLowerCase().includes(query));
  useEffect(() => {
    if (!open) return;
    searchInput.current?.focus();
    function outside(event: PointerEvent) { if (!root.current?.contains(event.target as Node)) setOpen(false); }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  function choose(value: CountryCode) { setCountry(value); setOpen(false); setSearch(""); trigger.current?.focus(); }
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && event.target !== searchInput.current) {
      const options = Array.from(root.current?.querySelectorAll<HTMLButtonElement>(".auth-country-option") || []);
      if (!options.length) return;
      event.preventDefault();
      const current = options.indexOf(document.activeElement as HTMLButtonElement);
      const index = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      options[index].focus();
    }
  }
  return <div className="auth-country-select" ref={root} onKeyDown={keyboard} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}>
    <input type="hidden" name="countryCode" value={code} />
    <button ref={trigger} id="auth-countryCode" type="button" className="auth-country-trigger" aria-label={`Country code: ${names.of(country)}, ${code}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? "auth-country-picker" : undefined} data-invalid={!!error} aria-describedby={error ? "countryCode-error" : "phoneNumber-help"} onClick={() => { setOpen(!open); setSearch(""); }}>
      {Flag && <Flag aria-hidden="true" />}<span>{code}</span><svg className="auth-country-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    {open && <div className="auth-country-picker" id="auth-country-picker" role="dialog" aria-label="Choose country code">
      <input ref={searchInput} className="auth-country-search" type="search" aria-label="Search countries or dialing codes" placeholder="Search country or code" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); if (matches[0]) choose(matches[0].country); }
        if (event.key === "ArrowDown") { event.preventDefault(); root.current?.querySelector<HTMLButtonElement>(".auth-country-option")?.focus(); }
      }} />
      <ul className="auth-country-options" aria-label="Countries">{matches.map((item) => {
        const ItemFlag = flags[item.country];
        return <li key={item.country}><button type="button" className="auth-country-option" data-selected={country === item.country} onClick={() => choose(item.country)}>{ItemFlag && <ItemFlag aria-hidden="true" />}<span>{item.name}</span><strong>{item.code}</strong>{country === item.country && <span className="auth-country-check" aria-label="Selected">✓</span>}</button></li>;
      })}</ul>
      {!matches.length && <p className="auth-country-empty" role="status">No countries found.</p>}
    </div>}
  </div>;
}
