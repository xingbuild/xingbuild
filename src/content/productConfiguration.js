const robotaxiHref = "https://robotaxi.xingbuild.top/";

export const robotaxiProductConfiguration = Object.freeze({
  homeActions: Object.freeze([
    Object.freeze({ id: "view-latest-product", label: "查看最新B端产品", href: "/products", kind: "internal" }),
    Object.freeze({ id: "browse-observations", label: "浏览经营观察", href: "/business-observations", kind: "internal" }),
  ]),
  heroActions: Object.freeze([
    Object.freeze({ id: "enter-robotaxi", label: "进入 Robotaxi运营平台", href: robotaxiHref, kind: "external" }),
    Object.freeze({ id: "browse-observations", label: "浏览经营观察", href: "/business-observations", kind: "internal" }),
  ]),
  closing: Object.freeze({
    title: "Robotaxi运营平台",
    summary: "这是 Robotaxi 运营中台的模拟作品，用于展示经营结构与产品交互；页面数据不代表真实城市运营或企业经营结果。",
    action: Object.freeze({ label: "进入 Robotaxi运营平台", href: robotaxiHref, kind: "external" }),
  }),
  productAction: Object.freeze({ label: "进入 Robotaxi运营平台", href: robotaxiHref, kind: "external" }),
});

export const productConfiguration = Object.freeze({
  robotaxi: robotaxiProductConfiguration,
});
