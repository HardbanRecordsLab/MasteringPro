import { Link, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/Brand";
import { Seo } from "@/components/Seo";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404 — nie znaleziono trasy:", location.pathname);
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-background noise-texture flex flex-col items-center justify-center px-4 text-center">
      <Seo title="404" description="Nie znaleziono strony." path={location.pathname} noIndex />
      <BrandMark className="w-12 h-12 mb-6" />
      <p className="font-mono-display text-sm text-primary mb-2">404</p>
      <h1 className="font-display text-3xl sm:text-4xl font-bold mb-3">Nie ma tu nic do zmasterowania</h1>
      <p className="text-muted-foreground max-w-md mb-8">
        Ta strona nie istnieje albo została przeniesiona. Wróć na stronę główną
        lub otwórz konsolę masteringu.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button asChild>
          <Link to="/">Strona główna</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/app">Otwórz konsolę</Link>
        </Button>
      </div>
    </div>
  );
};

export default NotFound;
