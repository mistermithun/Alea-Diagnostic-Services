import React, { useState } from 'react';

export const BRAND_LOGO_SRC = '/assets/aistudio/IMG_20261119_111655_480ab481.jpg';

interface BrandLogoProps {
  surface?: 'light' | 'dark' | 'print';
  className?: string;
  alt?: string;
}

export const BrandLogo: React.FC<BrandLogoProps> = ({
  surface = 'light',
  className = 'h-10 w-auto',
  alt = 'Alea Diagnostic Services Logo',
}) => {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        className={`inline-flex items-center justify-center rounded-lg bg-brand-navy text-white font-bold tracking-tight px-2.5 aspect-[938/804] shrink-0 ${className}`}
        aria-label={alt}
      >
        ADS
      </div>
    );
  }

  if (surface === 'dark') {
    return (
      <div className="inline-flex items-center justify-center bg-white rounded-xl p-1 shadow-sm ring-1 ring-white/20 shrink-0">
        <img
          src={BRAND_LOGO_SRC}
          alt={alt}
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className={`block object-contain aspect-[938/804] brightness-[1.03] contrast-[1.03] rounded-md ${className}`}
        />
      </div>
    );
  }

  if (surface === 'print') {
    return (
      <img
        src={BRAND_LOGO_SRC}
        alt={alt}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={`block object-contain aspect-[938/804] shrink-0 brightness-[1.03] contrast-[1.03] ${className}`}
      />
    );
  }

  return (
    <img
      src={BRAND_LOGO_SRC}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`block object-contain aspect-[938/804] shrink-0 rounded-lg brightness-[1.03] contrast-[1.03] ${className}`}
    />
  );
};
