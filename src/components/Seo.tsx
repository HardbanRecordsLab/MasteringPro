import { Helmet } from 'react-helmet-async';

const SITE = 'MasteringPro';
const ORIGIN = 'https://masteringpro.hardbanrecordslab.online';
const DEFAULT_DESC =
  'MasteringPro — browser-based AI audio mastering console with BS.1770-4 metering, a full pro DSP chain and an AI mastering copilot.';

interface SeoProps {
  title?: string;
  description?: string;
  /** Path only, e.g. "/legal/privacy". Defaults to the current location. */
  path?: string;
  /** Set true on utility pages (404, legal) to keep them out of the index. */
  noIndex?: boolean;
}

/** Per-route document head — title, description, canonical, OG/Twitter. */
export function Seo({ title, description, path, noIndex }: SeoProps) {
  const fullTitle = title ? `${title} — ${SITE}` : `${SITE} — Professional AI Audio Mastering`;
  const desc = description ?? DEFAULT_DESC;
  const url = ORIGIN + (path ?? (typeof window !== 'undefined' ? window.location.pathname : '/'));

  return (
    <Helmet>
      <title>{fullTitle}</title>
      <meta name="description" content={desc} />
      <link rel="canonical" href={url} />
      {noIndex && <meta name="robots" content="noindex, follow" />}
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={desc} />
      <meta property="og:url" content={url} />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={desc} />
    </Helmet>
  );
}
