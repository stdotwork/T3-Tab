/** Agent text as markdown with no remote images, so a reply cannot load anything by being shown. Loaded on first use. */
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const plugins = [remarkGfm];

export default function Markdown({ text }: { text: string }): ReactNode {
  return (
    <ReactMarkdown
      remarkPlugins={plugins}
      components={{
        img: ({ alt }) => <span className="md-image">{alt ?? 'image'}</span>,
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
