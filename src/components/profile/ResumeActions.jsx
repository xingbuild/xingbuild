import { resolveResumeArtifact } from "../../content/resumeArtifact.js";

function downloadName(now = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `金星简历${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}.pdf`;
}

export function ResumeActions({ artifactRef = null, now = new Date() } = {}) {
  const artifact = resolveResumeArtifact(artifactRef);
  if (!artifact?.pdfPath || !artifact?.pdfSha256 || artifact.publicStatus !== "verified") return null;
  return (
    <section className="resume-actions" aria-label="简历入口">
      <div className="resume-actions__links">
        <a href={artifact.pdfPath} target="_blank" rel="noreferrer">查看简历</a>
        <a href={artifact.pdfPath} download={downloadName(now)}>下载简历</a>
      </div>
    </section>
  );
}

export { downloadName };
