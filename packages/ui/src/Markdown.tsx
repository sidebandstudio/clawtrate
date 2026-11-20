import { memo, type ReactNode } from "react";
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

/** How a surface draws a link instead of the direct one: given its address and its words. */
export type LinkRenderer = (props: { href: string | undefined; children: ReactNode }) => ReactNode;

/**
 * Model output rendered as GitHub-flavored markdown. Raw HTML is not rendered.
 * `link`, where given, draws every link in place of the direct anchor.
 */
export const Markdown = memo(function Markdown({
  text,
  link,
}: {
  text: string;
  link?: LinkRenderer;
}) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={
          link ? { ...components, a: ({ href, children }) => link({ href, children }) } : components
        }
        skipHtml
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
