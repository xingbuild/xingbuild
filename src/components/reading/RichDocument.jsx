import { Link } from "../../lib/navigation";
import { classifySourceUrl } from "../../content/sourceUrls";
import { diagramFigureAssets } from "../../content/diagramFigureAssets";
import { EnterpriseArchitectureViews } from "./EnterpriseArchitectureViews.jsx";

function SourceLinks({ sources = [], prefix = "来源：" }) {
  return <p className="rich-document__sources">{prefix}{sources.map((source, index) => {
    const safe = classifySourceUrl(source);
    if (!safe.valid) return null;
    return <span key={source.id}>{index ? "、" : null}<a href={safe.href} {...(safe.kind === "external" ? { target: "_blank", rel: "noreferrer" } : {})}>{source.publisher}</a></span>;
  })}</p>;
}

export function RichDocument({ blocks = [], sources, showFigures = true, showArchitectureViews = true }) {
  return (
    <div className="rich-document">
      {blocks.map((block, index) => {
        if (block.type === "lead") return <p className="rich-document__lead" key={index}>{block.text}</p>;
        if (block.type === "heading") { const Heading = `h${block.level || 2}`; return <Heading id={block.id} key={index}>{block.text}</Heading>; }
        if (block.type === "paragraph") return <p key={index}>{block.text}</p>;
        if (block.type === "list") return <ul key={index}>{block.items.map((item, itemIndex) => { const value = typeof item === "string" ? item : item.text; return <li key={item.id || value || itemIndex}>{value}</li>; })}</ul>;
        if (block.type === "definitionList") return <dl key={index}>{block.items.map((item) => <div key={item.term}><dt>{item.term}</dt><dd>{item.description}</dd></div>)}</dl>;
        if (block.type === "callout") return <div className="rich-document__callout" role="note" key={index}>{block.text}</div>;
        if (block.type === "figure") {
          if (!showFigures) return null;
          const assets = diagramFigureAssets(block.sourcePath);
          return <figure className="rich-document__figure" key={index}>
          <picture>{assets ? <source media="(max-width: 32.4375rem)" srcSet={assets.mobile} /> : null}<img src={assets?.desktop} alt={block.alt} /></picture>
          <figcaption>{block.caption}</figcaption>
        </figure>; }
        if (block.type === "architectureViews") return showArchitectureViews ? <EnterpriseArchitectureViews key={block.id} /> : null;
        if (block.type === "link") return <p key={index}><Link href={block.href}>{block.text}</Link></p>;
        return null;
      })}
      {sources?.length ? <SourceLinks sources={sources} /> : null}
    </div>
  );
}

export { SourceLinks };
