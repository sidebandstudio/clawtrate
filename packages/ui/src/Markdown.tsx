import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  // Links leave the app; hosts open them in the system browser.
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  // A table may be wider than the bubble's text: it takes the room beside the
  // message, and scrolls inside itself when even that is not enough.
  table: ({ children }) => (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  ),
  // Transcripts are untrusted; never load remote images from them.
  img: ({ alt }) => <span>{alt ? `[image: ${alt}]` : "[image]"}</span>,
};

/** Model output rendered as GitHub-flavored markdown. Raw HTML is not rendered. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
});
