import { lazy, Suspense, useEffect } from "react";
import { NotFoundPage } from "./pages/NotFoundPage";
import { RobotaxiPage } from "./pages/RobotaxiPage";
import { ObservationPage } from "./pages/ObservationPage";
import { DraftObservationPage } from "./pages/DraftObservationPage";
import { SiteFooter } from "./components/site/SiteFooter";
import { SiteHeader } from "./components/site/SiteHeader";
import { PageCompositionRenderer } from "./components/page-compositions/PageCompositionRenderer";
import { navigate, useLocation } from "./lib/navigation";
import { site } from "./content/siteContent";
import { findObservation } from "./content/observationRepository";
import { findPageDefinitionByRoute } from "./content/pageDefinitions";
import { startVisitQualification } from "./lib/visitQualification";
import { CapabilityFixturePage } from "./pages/CapabilityFixturePage";
import { useContentDataRuntime } from "./content/contentDataRuntimeHook.js";
import { resolveRuntimeObservation } from "./content/runtimeContentProjection.js";

const BusinessObservationsPage = lazy(() => import("./pages/BusinessObservationsPage").then((module) => ({ default: module.BusinessObservationsPage })));
const FRAMEWORK_BASE = "/enterprise-operating-framework";

function RuntimeLoading() {
  return <p className="route-loading" role="status">正在载入内容…</p>;
}

function resolvePage(location, runtime) {
  const { pathname } = location;
  if (pathname === "/__fixtures__/capability-stage") return <CapabilityFixturePage />;
  const definition = findPageDefinitionByRoute(pathname);
  if (definition) return <PageCompositionRenderer definition={definition} location={location} runtime={runtime} />;
  if (pathname === FRAMEWORK_BASE) return <BusinessObservationsPage />;

  if (pathname.startsWith("/observations/")) {
    const slug = pathname.split("/")[2];
    if (new URLSearchParams(location.search).get("draft") === "1") {
      return <DraftObservationPage slug={slug} />;
    }
    if (runtime.status === "loading") return <RuntimeLoading />;
    const observation = resolveRuntimeObservation(slug, runtime.data) || findObservation(slug);
    return observation ? (
      observation.presentation === "brief" ? <BriefRedirect /> : <ObservationPage observation={observation} location={location} />
    ) : (
      <NotFoundPage />
    );
  }

  if (pathname.startsWith("/works/")) {
    const parts = pathname.split("/").filter(Boolean);
    if (parts[1] === "enterprise-operating-framework") return <BusinessObservationsPage />;
    if (parts[1] === "robotaxi") return <RobotaxiPage />;
    return <NotFoundPage />;
  }

  return <NotFoundPage />;
}

function BriefRedirect() {
  useEffect(() => { navigate("/observations", { replace: true }); }, []);
  return null;
}

export function App() {
  const location = useLocation();
  const { pathname } = location;
  const runtime = useContentDataRuntime();

  useEffect(() => startVisitQualification(), []);

  useEffect(() => {
    if (pathname === "/business-observations" && new URLSearchParams(location.search).get("view") === "digital-implementation") {
      navigate("/business-observations#digital-implementation", { replace: true, scroll: false });
      return;
    }
    const redirects = {
      "/robotaxi": "/products",
      "/works": "/products",
      "/works/robotaxi": "/products",
      "/products/robotaxi": "/products",
      "/enterprise-operating-framework": "/business-observations",
      "/works/enterprise-operating-framework": "/business-observations",
    };
    if (redirects[pathname]) {
      navigate(redirects[pathname], { replace: true });
      return;
    }
    const labels = {
      "/": site.name,
      "/products": "B端产品",
      "/business-observations": "经营观察",
      [FRAMEWORK_BASE]: "企业经营体系",
      "/observations": "观察",
      "/about": "关于我",
    };
    const title =
      labels[pathname] ??
      (pathname.startsWith("/observations/") ? "观察" : site.name);
    document.title = title === site.name ? title : `${title} · ${site.name}`;
  }, [pathname, location.search]);

  return (
    <div className="site-shell">
      <SiteHeader pathname={pathname} />
      <main id="main-content"><Suspense fallback={<p className="route-loading" role="status">正在载入页面…</p>}>{resolvePage(location, runtime)}</Suspense></main>
      <SiteFooter />
    </div>
  );
}
