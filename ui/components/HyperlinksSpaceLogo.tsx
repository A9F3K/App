/**
 * 32×32 logo matching Dart GlobalLogoBar asset (HyperlinksSpace.svg).
 * Inline SVG paths to avoid asset transformer; fill #00E05A.
 */
import React from "react";
import Svg, { Path } from "react-native-svg";

export const HYPERLINKS_SPACE_LOGO_GREEN = "#00E05A";

const LOGO_SIZE = 32;

export function HyperlinksSpaceLogo({
  width = LOGO_SIZE,
  height = LOGO_SIZE,
}: {
  width?: number;
  height?: number;
}) {
  return (
    <Svg width={width} height={height} viewBox="0 0 28.5301 29.6462" fill="none">
      <Path
        d="M7.13281 29.0756L15.6917 24.2257L20.2565 29.6462H28.5301V1.11719H27.1036V28.2198H21.3977L7.13281 10.5318V29.0756Z"
        fill={HYPERLINKS_SPACE_LOGO_GREEN}
      />
      <Path
        d="M21.3973 1.68777L12.5531 6.5377L7.98832 1.11719H0V29.6462H1.42649V2.54364H7.13243L21.3973 21.3728V1.68777Z"
        fill={HYPERLINKS_SPACE_LOGO_GREEN}
      />
    </Svg>
  );
}
