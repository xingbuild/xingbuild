import { robotaxiProductConfiguration } from "../../content/productConfiguration.js";
import { ClosingAction } from "../showcase/ClosingAction.jsx";
import { ProductHero, PracticeModuleList } from "../practice/PracticePrimitives.jsx";

const HOME_CLOSING_ACTION = Object.freeze({
  title: "查看我的最新作品",
  summary: "它将经营规划、需求、供给、运营调度、订单、履约、指标、经营反馈连接成可运行可学习经营闭环",
  action: robotaxiProductConfiguration.productAction,
});

function projectHomeClosingAction() {
  return HOME_CLOSING_ACTION;
}

function EmptyHomeProduct() {
  return <section className="home-product-section content-empty-state" aria-label="内容状态"><p>暂无已发布内容</p></section>;
}

/** Home owns its product-section label, hero semantics, actions and closing. */
export function HomeProductProjection({ practice }) {
  if (!practice) return <EmptyHomeProduct />;
  return (
    <div className="home-product-section">
      <ProductHero practice={practice} headingLevel={2} headingId="home-product-title" eyebrow="最新作品" eyebrowAlign="start" introProjection="home.productHero.intro" actions={[]} />
      <PracticeModuleList modules={practice.modules} headingLevel={3} />
      <ClosingAction closing={projectHomeClosingAction()} />
    </div>
  );
}
