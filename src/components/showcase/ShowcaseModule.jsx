import { SystemStage } from "./SystemStage.jsx";
import { ResponsiveText } from "../content/ResponsiveText.jsx";

export function ShowcaseModule({ module, headingLevel = 2, textProjection }) {
  const Heading = `h${headingLevel}`;
  const title = typeof module.label === "string" ? module.label.trim() : "";
  const group = typeof module.group === "string" ? module.group.trim() : "";
  const label = group && group !== title ? group : "";
  return (
    <article className="showcase-module">
      <div className="showcase-module__copy">
        {label ? <p className="showcase-module__label">{label}</p> : null}
        <Heading>{module.label}</Heading>
        {module.shortDescription ? <ResponsiveText value={module.shortDescription} projection={textProjection} profile="auto" as="p" /> : null}
      </div>
      <SystemStage media={module.media} action={module.action} />
    </article>
  );
}
