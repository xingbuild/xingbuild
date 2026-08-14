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

function textParts(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function ParagraphParts({ value, className, as = "p", targetId }) {
  const Tag = as;
  const parts = textParts(value);
  return parts.map((part, index) => <Tag className={className} data-xingbuild-content-target={targetId || undefined} key={`${index}-${part}`}>{part}</Tag>);
}

export function RichDocument({ blocks = [], sources, showFigures = true, showArchitectureViews = true, targetPrefix = null }) {
  const targetFor = (block, suffix = "text") => targetPrefix && block?.id ? `${targetPrefix}.block.${block.id}.${suffix}` : undefined;
  return (
    <div className="rich-document">
      {blocks.map((block) => {
        if (block.type === "lead") return <ParagraphParts className="rich-document__lead" key={block.id} value={block.text} targetId={targetFor(block)} />;
        if (block.type === "heading") { const Heading = `h${block.level || 2}`; return <Heading id={block.id} data-xingbuild-content-target={targetFor(block)} key={block.id}>{Array.isArray(block.text) ? block.text.join(" ") : block.text}</Heading>; }
        if (block.type === "paragraph") return <ParagraphParts key={block.id} value={block.text} targetId={targetFor(block)} />;
        if (block.type === "list") return <ul key={block.id}>{block.items.map((item, itemIndex) => { const value = typeof item === "string" ? item : item.text; const itemId = typeof item === "object" ? item.id : null; return <li key={itemId || value || itemIndex}><ParagraphParts value={value} targetId={itemId ? targetFor(block, `item.${itemId}.text`) : targetFor(block)} /></li>; })}</ul>;
        if (block.type === "definitionList") return <dl key={block.id}>{block.items.map((item) => <div key={item.id || item.term}><dt data-xingbuild-content-target={item.id ? targetFor(block, `item.${item.id}.term`) : undefined}>{item.term}</dt><dd><ParagraphParts value={item.description} targetId={item.id ? targetFor(block, `item.${item.id}.description`) : undefined} /></dd></div>)}</dl>;
        if (block.type === "callout") return <div className="rich-document__callout" role="note" key={block.id}><ParagraphParts value={block.text} targetId={targetFor(block)} /></div>;
        if (block.type === "figure") {
          if (!showFigures) return null;
          const assets = diagramFigureAssets(block.sourcePath);
          return <figure className="rich-document__figure" key={block.id}>
          <picture>{assets ? <source media="(max-width: 32.4375rem)" srcSet={assets.mobile} /> : null}<img src={assets?.desktop} alt={block.alt} data-xingbuild-content-target={targetFor(block, "alt")} /></picture>
          {block.caption ? <figcaption data-xingbuild-content-target={targetFor(block, "caption")}>{block.caption}</figcaption> : null}
        </figure>; }
        if (block.type === "architectureViews") return showArchitectureViews ? <EnterpriseArchitectureViews key={block.id} /> : null;
        if (block.type === "link") return <p key={block.id}><Link href={block.href}>{block.text}</Link></p>;
        return null;
      })}
      {sources?.length ? <SourceLinks sources={sources} /> : null}
    </div>
  );
}

export { SourceLinks };
