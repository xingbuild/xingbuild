import { useLayoutEffect, useRef, useState } from "react";
import { Link, observationCollectionHref } from "../../lib/navigation";
import { countCompleteBriefs } from "../../content/briefRail";
import { classifySourceUrl } from "../../content/sourceUrls";

function BriefBody({ item, returnTo = "/observations" }) {
  const target = (field) => item.slug ? `observations.${item.slug}.${field}` : undefined;
  const sources = item.sourceRefs
    .map((id) => item.sources.find((source) => source.id === id))
    .filter((source, index, all) => source && all.findIndex((candidate) => candidate?.publisher === source.publisher) === index);
  return (
    <>
      <p className="brief-item__identity">
        <span data-xingbuild-content-target={target("brief.subject")}>{item.subject}</span>
        <time dateTime={item.eventAt} data-xingbuild-content-target={target("eventAt")}>{item.eventAt}</time>
      </p>
      <p className="brief-item__dimension">
        <span data-xingbuild-content-target={target("primaryDimension")}>#{item.primaryDimension}</span>
        {item.isOpinion ? <span>#观点</span> : null}
      </p>
      <p className="brief-item__statement" data-xingbuild-content-target={target(`brief.${item.bodyTargetField || "body"}`)}>{item.body || item.statement}</p>
      {item.articlePreview ? <Link className="brief-item__article-preview" href={`${item.articlePreview.href}?returnTo=${encodeURIComponent(returnTo)}`}>{item.articlePreview.title}<span>{item.articlePreview.excerpt}</span></Link> : null}
      <p className="brief-item__sources">
        来源：{sources.map((source, index) => {
          const safe = classifySourceUrl(source);
          if (!safe.valid) return null;
          return <span key={source.id}>{index ? "、" : null}<a href={safe.href} {...(safe.kind === "external" ? { target: "_blank", rel: "noreferrer" } : {})}>{source.publisher}</a></span>;
        })}
      </p>
    </>
  );
}

export function BriefItem({ item, returnTo }) {
  return <article className="brief-item"><BriefBody item={item} returnTo={returnTo} /></article>;
}

export function ObservationStream({ items, returnTo }) {
  return <div className="observation-stream">{items.map((item) => <BriefItem item={item} returnTo={returnTo} key={item.id} />)}</div>;
}

export function ObservationEmptyState({ title, message, description }) {
  return (
    <section className="observation-empty-state" aria-labelledby="observations-empty-title">
      <p data-xingbuild-content-target="site.sharedCopy.emptyStates.observations.message">{message}</p>
      {description ? <p data-xingbuild-content-target="site.sharedCopy.emptyStates.observations.description">{description}</p> : null}
    </section>
  );
}

export function ObservationRail({ items, anchorRef, origin }) {
  const measureRef = useRef(null);
  const [visibleCount, setVisibleCount] = useState(0);

  useLayoutEffect(() => {
    if (!anchorRef?.current || !measureRef.current || !items.length) return undefined;
    const update = () => {
      const budget = Math.min(anchorRef.current.getBoundingClientRect().height, window.innerHeight * 2);
      const measureBounds = measureRef.current.getBoundingClientRect();
      const entries = [...measureRef.current.querySelectorAll("[data-brief-measure]")].map((entry) => {
        const bounds = entry.getBoundingClientRect();
        return { top: bounds.top - measureBounds.top, height: bounds.height };
      });
      const more = measureRef.current.querySelector("[data-rail-more-measure]")?.getBoundingClientRect();
      const railGap = Number.parseFloat(getComputedStyle(measureRef.current).rowGap) || 0;
      const count = countCompleteBriefs(entries, budget, {
        moreHeight: more?.height ?? 0,
        railGap,
      });
      setVisibleCount((current) => current === count ? current : count);
    };
    const observer = new ResizeObserver(update);
    observer.observe(anchorRef.current);
    window.addEventListener("resize", update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [anchorRef, items.length]);

  const visible = items.slice(0, visibleCount);
  return (
    <div className="observation-rail">
      <div className="observation-rail__measure" ref={measureRef} aria-hidden="true" inert>
        <div className="observation-stream">
          {items.map((item) => (
            <article className="brief-item" data-brief-measure key={item.id}><BriefBody item={item} /></article>
          ))}
        </div>
        <span className="observation-rail__more" data-rail-more-measure>更多观察</span>
      </div>
      <ObservationStream items={visible} returnTo={observationCollectionHref(origin)} />
      <Link className="observation-rail__more" href={observationCollectionHref(origin)}>更多观察</Link>
    </div>
  );
}
