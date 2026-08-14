import { ActionGroup } from "../site/ActionGroup.jsx";
import { ShowcaseModule } from "../showcase/ShowcaseModule.jsx";
import { ResponsiveText } from "../content/ResponsiveText.jsx";

/**
 * Page-neutral primitives shared by the Home and Products compositions.
 * Page-level structure and lifecycle decisions belong to their callers.
 */
export function ProductHero({ practice, headingLevel = 1, headingId, actions = [], eyebrow = null, eyebrowAlign = "center", showBoundary = false, align = "center", introProjection = "products.productHero.intro", showWhy = false, whyProjectionPrefix = "products.productHero.why" }) {
  const Heading = `h${headingLevel}`;
  const alignmentClass = align === "start" ? " product-hero--start" : "";
  const eyebrowClass = eyebrowAlign === "start" ? " product-hero__eyebrow--start" : "";
  const whyVisible = showWhy && practice.why?.items?.length;
  return (
    <header className={`product-hero${headingLevel > 1 ? " product-hero--compact" : ""}${alignmentClass}${whyVisible ? " product-hero--with-why" : ""}`}>
      <div className="product-hero__heading">
        {eyebrow ? <p className={`eyebrow product-hero__eyebrow${eyebrowClass}`}>{eyebrow}</p> : null}
        <Heading id={headingId} data-xingbuild-content-target="products.robotaxi.title">{practice.title}</Heading>
      </div>
      {practice.intro ? <ResponsiveText value={practice.intro} projection={introProjection} profile="auto" as="p" className="product-hero__intro" targetId="products.robotaxi.intro" /> : null}
      {showBoundary && practice.boundary ? <p className="product-hero__boundary">{practice.boundary}</p> : null}
      {whyVisible ? (
        <section className="product-hero__why" aria-label={practice.why.eyebrow ? undefined : "为什么做"}>
          {practice.why.eyebrow ? <ResponsiveText value={practice.why.eyebrow} projection={`${whyProjectionPrefix}.eyebrow`} profile="auto" as="p" className="eyebrow product-hero__why-eyebrow" targetId="products.robotaxi.why.eyebrow" /> : null}
          <div className="product-hero__why-items">
            {practice.why.items.map((item) => <ResponsiveText key={item.id} value={item.text} projection={`${whyProjectionPrefix}.item.${item.id}.text`} profile="auto" as="p" className="product-hero__why-item" targetId={`products.robotaxi.why.item.${item.id}.text`} />)}
          </div>
        </section>
      ) : null}
      {actions.length ? <ActionGroup actions={actions} equalWidth /> : null}
    </header>
  );
}

export function PracticeModule({ module, headingLevel = 2 }) {
  return <ShowcaseModule module={module} headingLevel={headingLevel} textProjection={`products.showcase.module.${module.id}.shortDescription`} />;
}

export function PracticeModuleList({ modules = [], headingLevel = 2 }) {
  if (!modules.length) return <section className="practice-module-list content-empty-state" aria-label="产品模块状态"><p>暂无已发布产品模块</p></section>;
  return <section className="practice-module-list" aria-label="产品说明与媒体">{modules.map((module) => <PracticeModule key={module.id} module={module} headingLevel={headingLevel} />)}</section>;
}
