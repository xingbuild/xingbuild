import { normalizeResponsiveTextSlot } from "../../content/responsiveTextSlot.js";

/** Shared renderer: content may request semantic breaks, never HTML/CSS. */
export function ResponsiveText({ value, projection, profile = "web", as: Element = "span", className = "" }) {
  const slot = normalizeResponsiveTextSlot(value);
  const resolvedProfile = profile === "auto"
    ? (typeof window !== "undefined" && window.matchMedia?.("(max-width: 767px)").matches ? "mobile" : "web")
    : profile;
  const breaks = new Set(slot.projections[projection]?.[resolvedProfile]?.breakAfter || []);
  return (
    <Element className={className || undefined}>
      {slot.parts.flatMap((part) => breaks.has(part.id) ? [part.text, <br key={`${part.id}-break`} />] : [part.text])}
    </Element>
  );
}
