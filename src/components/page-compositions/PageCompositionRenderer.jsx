import { useRef } from "react";
import { ObservationEmptyState, ObservationStream, ObservationRail } from "../observations/Briefs";
import { HomeProductProjection } from "./HomeProductProjection.jsx";
import { ProductsShowcase } from "./ProductsShowcase.jsx";
import { EvergreenArticle } from "../reading/EvergreenArticle";
import { RichDocument } from "../reading/RichDocument";
import { ResumeActions } from "../profile/ResumeActions.jsx";
import { ActionGroup } from "../site/ActionGroup.jsx";
import { ReturnNavigation } from "../navigation/ReturnNavigation";
import {
  CollectionLayout,
  LayoutShell,
  ReadingShell,
  TwoColumnLayout,
} from "../site/LayoutShell";
import { resolvePageContent } from "../../content/pageContentResolver";
import {
  observationCollectionHref,
  returnDestinationFor,
  safeReturnTo,
} from "../../lib/navigation";
import { robotaxiProductConfiguration } from "../../content/productConfiguration.js";
import { ResponsiveText } from "../content/ResponsiveText.jsx";

function EmptyContentState() {
  return <section className="content-empty-state" aria-label="内容状态"><p>暂无已发布内容</p></section>;
}

function HomeComposition({ content }) {
  const productRef = useRef(null);
  const practice = content.practice;
  const briefs = content.briefs;
  return (
    <LayoutShell className="page-composition page-composition--home home-page">
      <section className="home-page__positioning-shell"><h1 className="home-page__positioning"><ResponsiveText value={content.home.homeTitle} projection="home.positioning.title" profile="auto" targetId="site.home.homeTitle" /></h1></section>
      <div className="home-page__actions-align">
        <ActionGroup className="home-page__actions" actions={robotaxiProductConfiguration.homeActions} equalWidth />
      </div>
      <section ref={productRef} className="home-page__projection" aria-labelledby="home-product-title"><HomeProductProjection practice={practice ? { ...practice, title: practice.title } : null} /></section>
      <section className="home-page__latest-briefs" aria-labelledby="home-briefs-title">
        <header className="section-heading"><h2 id="home-briefs-title">最新观察简讯</h2></header>
        {briefs.length ? <ObservationRail items={briefs} anchorRef={productRef} origin="/" /> : <ObservationEmptyState {...content.home.emptyStates.observations} />}
      </section>
    </LayoutShell>
  );
}

function ShowcaseComposition({ content }) {
  const practice = content.practice;
  return (
    <LayoutShell className="page-composition page-composition--showcase practice-page">
      {practice ? <ProductsShowcase practice={practice} /> : <EmptyContentState />}
    </LayoutShell>
  );
}

function CollectionComposition({ content, location }) {
  const briefs = content.briefs;
  const origin = safeReturnTo(new URLSearchParams(location?.search || "").get("origin"), "");
  const returnTo = observationCollectionHref(origin);
  return (
    <LayoutShell className="page-composition page-composition--collection observations-page">
      <CollectionLayout>
        <ReturnNavigation
          href={origin || "/business-observations"}
          destination={returnDestinationFor(origin || "/business-observations")}
          origin={origin}
          returnTo={returnTo}
          secondary={origin && origin !== "/business-observations" ? { href: "/business-observations", label: "经营观察" } : null}
        />
        <header className="observation-stream-header">
          <h1>观察</h1>
        </header>
        {briefs.length ? <ObservationStream items={briefs} returnTo={returnTo} /> : <ObservationEmptyState {...content.home.emptyStates.observations} />}
      </CollectionLayout>
    </LayoutShell>
  );
}

function ProfileReading({ profile: about }) {
  if (!about) return <EmptyContentState />;
  const hiddenHeadingIds = new Set(["resume", "direction"]);
  const hiddenBlockIds = new Set(["contact"]);
  const blocks = [];
  let suppressed = false;
  for (const block of about.blocks || []) {
    if (hiddenBlockIds.has(block.id)) continue;
    if (block.type === "heading" && hiddenHeadingIds.has(block.id)) {
      suppressed = true;
      continue;
    }
    if (block.type === "heading") suppressed = false;
    if (!suppressed) blocks.push(block);
  }
  return (
    <LayoutShell className="page-composition page-composition--reading about-page">
      <ReadingShell>
        <header className="reading-shell__header"><h1 data-xingbuild-content-target="profile.about.title">{about.title}</h1>{about.summary ? <p data-xingbuild-content-target="profile.about.summary">{about.summary}</p> : null}</header>
        <RichDocument blocks={blocks} targetPrefix="profile.about" />
        {about.blocks?.some((block) => block.id === "resume") ? <ResumeActions artifactRef={about.resumeArtifactRef} /> : null}
      </ReadingShell>
    </LayoutShell>
  );
}

function ArticleReading({ article, briefs, home }) {
  if (!article) return <EmptyContentState />;
  const renderRail = (anchorRef) => (
    <div className="business-observations-rail">
      <header className="business-observations-rail__header"><h2>最新简讯</h2></header>
      {briefs.length
        ? <ObservationRail items={briefs} anchorRef={anchorRef} origin="/business-observations" />
        : <ObservationEmptyState {...home?.emptyStates?.observations} />}
    </div>
  );
  return (
    <LayoutShell className="page-composition page-composition--reading framework-page">
      <header className="business-observations-page__header"><h1>经营观察</h1></header>
      <TwoColumnLayout renderRail={renderRail}>
        <header className="business-observations-column-heading"><h2>最新经营观察</h2></header>
        <EvergreenArticle article={article} headingLevel={3} showSummary={false} showFigures={false} showArchitectureViews={false} contentTargetPrefix="articles.enterprise-operating-system" />
      </TwoColumnLayout>
    </LayoutShell>
  );
}

function ReadingComposition({ content }) {
  if (content.profile) return <ProfileReading profile={content.profile} />;
  if (content.article) return <ArticleReading article={content.article} briefs={content.briefs || []} home={content.home} />;
  return <EmptyContentState />;
}

const compositionRenderers = Object.freeze({
  HomeComposition,
  ShowcaseComposition,
  CollectionComposition,
  ReadingComposition,
});

export function PageCompositionRenderer({ definition, location, runtime = { status: "disabled", data: null } }) {
  if (!definition || !compositionRenderers[definition.composition]) {
    throw new Error(`Unknown PageComposition: ${definition?.composition ?? "undefined"}`);
  }
  if (runtime.status === "loading") {
    return <p className="route-loading" role="status">正在载入内容…</p>;
  }
  const Renderer = compositionRenderers[definition.composition];
  return <Renderer definition={definition} content={resolvePageContent(definition, { runtimeData: runtime.data })} location={location} />;
}

export { compositionRenderers };
