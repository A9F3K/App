/**
 * Profile action / media icons matching `assets/profile/*.svg` and design sheet rows.
 */
import Svg, { Path, Rect, Text as SvgText } from "react-native-svg";

type StrokeIconProps = {
  color?: string;
  size?: number;
};

/** Messages bubble from `assets/profile/messages.svg` (50×50). */
export function ProfileMessagesIcon({ color = "#FFFFFF", size = 50 }: StrokeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 50 50" fill="none">
      <Path
        d="M17.5 15.5H32.5C33.58 15.5 34.4999 16.43 34.5 17.625V29.4385C34.4998 30.6334 33.5799 31.5635 32.5 31.5635H26.9092L26.7725 31.6709L21.9443 35.4736C21.9029 35.5055 21.8588 35.5054 21.8262 35.4883C21.7887 35.4686 21.75 35.4192 21.75 35.3447V31.5635H17.5C16.4201 31.5635 15.5002 30.6334 15.5 29.4385V17.625C15.5001 16.43 16.42 15.5 17.5 15.5Z"
        stroke={color}
      />
    </Svg>
  );
}

/** Phone handset from `assets/profile/phone.svg` (50×50). */
export function ProfilePhoneIcon({ color = "#FFFFFF", size = 50 }: StrokeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 50 50" fill="none">
      <Path
        d="M21.7632 15.9137C21.4474 15.2235 20.6148 14.8561 19.8191 15.0528L16.2099 15.9434C15.4963 16.1215 15 16.7078 15 17.3757C15 26.5562 23.2274 34 33.3742 34C34.1124 34 34.7605 33.551 34.9573 32.9053L35.9417 29.6398C36.159 28.92 35.753 28.1667 34.9901 27.8809L31.0528 26.3966C30.3843 26.1443 29.6091 26.3187 29.1539 26.8271L27.4969 28.6565C24.6095 27.4208 22.2717 25.3057 20.906 22.6933L22.928 21.1978C23.4899 20.7822 23.6826 20.0846 23.4037 19.4797L21.7632 15.9174V15.9137Z"
        stroke={color}
      />
    </Svg>
  );
}

/** Gift bow from `assets/profile/gift.svg` (50×50). */
export function ProfileGiftIcon({ color = "#FFFFFF", size = 50 }: StrokeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 50 50" fill="none">
      <Path
        d="M22.8827 20.9697L15.1599 19.6708L12.9148 18.0102L11.6557 14.0775L13.5972 11.4529L19.7207 11.3921L24.2081 16.8301M22.8827 20.9697L23.5454 18.8999L24.2081 16.8301M24.2081 16.8301L26.9318 17.6089M21.911 18.0595L19.6606 14.5256L16.7133 13.8751L14.1845 13.4763L11.6557 14.0775M22.8827 20.9697L26.2242 21.8525M25.8004 23.8341L20.2798 35.9932L19.4706 31.687L15.5652 32.5058L22.2075 21.8826L22.8827 20.9697M23.5454 18.8999L21.911 18.0595M26.2242 21.8525L28.806 23.7622L33.6921 24.9048L36.7264 24.3245L38.7523 21.5858L38.868 18.8466L37.803 16.9994L35.2203 15.7952L26.9318 17.6089M26.9318 17.6089L26.6193 20.3792M38.7523 21.5858L37.5677 20.6175M26.2242 21.8525L25.8004 23.8341M26.2485 24.8718L28.9006 37.9563L30.1964 35.0306L33.6753 38.3102L27.8784 24.3119L27.3459 23.3883L26.2242 21.8525M26.2242 21.8525L26.6193 20.3792M25.8004 23.8341L22.2075 21.8826M25.8004 23.8341L26.2485 24.8718M27.8784 24.3119L27.0635 24.5919L26.2485 24.8718M37.5677 20.6175L36.4794 19.7279L32.1824 19.1977L28.4009 19.7885L26.6193 20.3792M14.1845 13.4763L16.9111 17.1795L21.911 18.0595M28.4009 19.7885L32.632 22.4L37.5677 20.6175"
        stroke={color}
      />
    </Svg>
  );
}

/** Block hatch from `assets/profile/block.svg` (20×20). */
export function ProfileBlockIcon({ color = "#FF1111", size = 20 }: StrokeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <Path
        d="M3.6416 0.00413782L20 10.9254V9.9828L5.05566 0.00413782H3.6416ZM6.95789 0.00413782L20 6.63954V5.75974L8.68758 0.00413782H6.95789ZM11.2632 0.00413782L20 3.02438V2.19695L13.5652 0.00413782C11.259 -0.00256545 11.2758 -5.17228e-05 11.2632 0.00413782ZM0.00883779 0.0929562V0.724321L1.46497 2.35531C1.71075 2.58364 2.03312 2.59118 2.26459 2.36076C2.50153 2.12447 2.50573 1.80439 2.28142 1.56349C1.75536 1.07289 1.22846 0.583133 0.701976 0.0929562H0.00883779ZM2.96825 1.16548C3.2136 1.50651 3.27673 1.93594 3.16731 2.32515C3.57427 2.63559 3.95724 3.02019 4.34863 3.37379C5.07249 3.31723 5.61539 3.91215 5.99836 4.30596C6.04044 3.75294 5.8721 3.15803 5.426 2.75332C4.95886 2.32724 4.38651 2.00339 3.87307 1.64434C3.57427 1.43696 3.29777 1.2279 2.96825 1.16506V1.16548ZM1.43972 4.05459C1.81007 4.54477 2.20946 5.06846 2.57349 5.58796C3.01707 6.01111 3.60794 6.2164 4.16767 6.17031C3.76786 5.70946 3.15889 5.16063 3.23885 4.58666C2.87314 4.13838 2.52131 3.71943 2.17368 3.26905C1.7642 3.35996 1.31936 3.2569 0.983524 2.97704C0.992782 3.41401 1.22046 3.76132 1.43972 4.05459ZM0 3.80741V5.2109L9.90384 20H10.8507L0 3.80741ZM4.16346 4.27245C3.95724 4.47354 3.95724 4.72911 4.14662 4.93858C5.07249 6.01949 5.99836 7.10877 6.92423 8.19386C7.23986 8.47875 7.66071 8.48713 7.95531 8.18967C8.26253 7.88802 8.26673 7.46488 7.98056 7.15485C6.85268 6.1745 5.76689 5.11873 4.80315 4.28083C4.59272 4.0923 4.34021 4.10486 4.16346 4.27245ZM7.13465 5.32821C7.81222 5.89799 8.83067 6.58927 8.9443 7.39366C9.62187 8.0179 10.3247 8.65052 11.0107 9.27476C12.2353 9.14489 12.9676 10.3347 13.6199 10.9296C13.8093 9.85711 13.5316 8.66309 12.6604 7.87127C11.8566 7.1381 10.977 6.62697 10.1984 6.06138C9.54191 5.57958 8.83067 5.2109 8.08156 5.19415C7.75751 5.19415 7.41241 5.24442 7.13465 5.32821ZM0 7.15066V8.87257L5.6701 20H6.55388L0 7.15066ZM5.1777 7.35176C4.89153 8.36563 5.30396 9.37531 5.93944 10.2928C6.52442 11.1391 7.17674 12.0357 7.69859 12.7772C8.62025 13.8037 9.84913 14.0131 10.9854 13.7283C10.3794 13.037 9.50403 12.287 9.32306 11.4156C8.55291 10.4855 8.08156 9.94928 7.38716 9.17421C6.48654 9.22868 5.87631 8.23995 5.1777 7.35176ZM10.3878 10.3473C9.92909 10.7956 10.0638 11.4617 10.3752 11.8052L14.9456 17.1553C15.56 17.7293 16.4312 17.7418 17.0204 17.1553C17.6222 16.5646 17.6264 15.6973 17.0541 15.0899C15.3117 13.5104 13.5526 11.9393 11.8103 10.3599C11.3011 9.95347 10.8213 9.93671 10.3878 10.3473ZM0 11.3947V13.8162L2.09877 20H2.92995L0 11.3947ZM15.0971 12.2619C15.9599 12.9993 16.7805 13.7911 17.6264 14.5452C17.9799 14.8594 18.1525 15.3119 18.2198 15.7434C18.4008 15.8314 18.5775 15.9529 18.7375 16.1037L19.9916 17.2517V12.9029C18.3671 11.91 16.8605 11.6125 15.0971 12.2619ZM12.2227 15.1778C11.6293 16.7657 11.8524 18.5881 12.8834 20H17.1845C15.9262 18.4373 17.1845 20.0126 15.842 18.3577C15.3202 18.32 14.7815 18.1315 14.3943 17.7167C13.641 16.9081 12.9424 16.0241 12.2227 15.1778Z"
        fill={color}
      />
    </Svg>
  );
}

export function ProfileMusicNoteIcon({ color = "#FFFFFF", size = 14 }: StrokeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <Path
        d="M5.5 11.5V3.75L11.5 2.5V9.75"
        stroke={color}
        strokeWidth={1.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M5.5 11.5C5.5 12.3284 4.82843 13 4 13C3.17157 13 2.5 12.3284 2.5 11.5C2.5 10.6716 3.17157 10 4 10C4.82843 10 5.5 10.6716 5.5 11.5Z"
        stroke={color}
        strokeWidth={1.2}
      />
      <Path
        d="M11.5 9.75C11.5 10.5784 10.8284 11.25 10 11.25C9.17157 11.25 8.5 10.5784 8.5 9.75C8.5 8.92157 9.17157 8.25 10 8.25C10.8284 8.25 11.5 8.92157 11.5 9.75Z"
        stroke={color}
        strokeWidth={1.2}
      />
    </Svg>
  );
}

export function ProfileMarkedIcon({ color = "#FFFFFF", size = 18 }: StrokeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 18 18" fill="none">
      <Path
        d="M9 1.5L10.35 6.15L15 7.5L10.35 8.85L9 13.5L7.65 8.85L3 7.5L7.65 6.15L9 1.5Z"
        stroke={color}
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function ProfileImagesIcon({ color = "#FFFFFF", size = 18 }: StrokeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 18 18" fill="none">
      <Rect x={2} y={4} width={14} height={10} rx={1} stroke={color} strokeWidth={1.2} />
      <Path
        d="M7.5 7.2V12.8L12.2 10L7.5 7.2Z"
        fill={color}
      />
    </Svg>
  );
}

export function ProfilePhotosIcon({ color = "#FFFFFF", size = 18 }: StrokeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 18 18" fill="none">
      <Path
        d="M3.5 6.5H5L6 4.5H12L13 6.5H14.5C15.3284 6.5 16 7.17157 16 8V13.5C16 14.3284 15.3284 15 14.5 15H3.5C2.67157 15 2 14.3284 2 13.5V8C2 7.17157 2.67157 6.5 3.5 6.5Z"
        stroke={color}
        strokeWidth={1.2}
      />
      <Path
        d="M11.75 10.25C11.75 11.4926 10.7426 12.5 9.5 12.5C8.25736 12.5 7.25 11.4926 7.25 10.25C7.25 9.00736 8.25736 8 9.5 8C10.7426 8 11.75 9.00736 11.75 10.25Z"
        stroke={color}
        strokeWidth={1.2}
      />
    </Svg>
  );
}

export function ProfileLinksIcon({ color = "#FFFFFF", size = 18 }: StrokeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 18 18" fill="none">
      <Path
        d="M7.25 10.75L10.75 7.25"
        stroke={color}
        strokeWidth={1.2}
        strokeLinecap="round"
      />
      <Path
        d="M8.5 12.5L7.25 13.75C6.00736 14.9926 3.99264 14.9926 2.75 13.75C1.50736 12.5074 1.50736 10.4926 2.75 9.25L4 8"
        stroke={color}
        strokeWidth={1.2}
        strokeLinecap="round"
      />
      <Path
        d="M9.5 5.5L10.75 4.25C11.9926 3.00736 14.0074 3.00736 15.25 4.25C16.4926 5.49264 16.4926 7.50736 15.25 8.75L14 10"
        stroke={color}
        strokeWidth={1.2}
        strokeLinecap="round"
      />
      <Path d="M3.5 14.5L14.5 3.5" stroke={color} strokeWidth={1.2} strokeLinecap="round" />
    </Svg>
  );
}

export function ProfileGifIcon({ color = "#FFFFFF", size = 18 }: StrokeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 18 18" fill="none">
      <SvgText
        x={9}
        y={12.5}
        fill={color}
        fontSize={8}
        fontWeight="700"
        textAnchor="middle"
        fontFamily="sans-serif"
      >
        GIF
      </SvgText>
    </Svg>
  );
}

/** Bell for mute / unmute channel notifications. */
export function ProfileMuteIcon({ color = "#FFFFFF", size = 50 }: StrokeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 50 50" fill="none">
      <Path
        d="M25 14.5C21.9624 14.5 19.5 16.9624 19.5 20V24.2L17.2 28.5H32.8L30.5 24.2V20C30.5 16.9624 28.0376 14.5 25 14.5Z"
        stroke={color}
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
      <Path
        d="M22.5 32.5C23.1 33.7 24.0 34.5 25 34.5C26 34.5 26.9 33.7 27.5 32.5"
        stroke={color}
        strokeWidth={1.2}
        strokeLinecap="round"
      />
      <Path d="M16 16L34 34" stroke={color} strokeWidth={1.2} strokeLinecap="round" />
    </Svg>
  );
}

/** Speech bubble for linked discussion group. */
export function ProfileDiscussIcon({ color = "#FFFFFF", size = 50 }: StrokeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 50 50" fill="none">
      <Path
        d="M16 17.5H34C35.3807 17.5 36.5 18.6193 36.5 20V29C36.5 30.3807 35.3807 31.5 34 31.5H24L19 35.5V31.5H16C14.6193 31.5 13.5 30.3807 13.5 29V20C13.5 18.6193 14.6193 17.5 16 17.5Z"
        stroke={color}
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Sliders for channel Manage (admin/creator). */
export function ProfileManageIcon({ color = "#FFFFFF", size = 50 }: StrokeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 50 50" fill="none">
      <Path d="M15 20H35" stroke={color} strokeWidth={1.2} strokeLinecap="round" />
      <Path d="M15 25H35" stroke={color} strokeWidth={1.2} strokeLinecap="round" />
      <Path d="M15 30H35" stroke={color} strokeWidth={1.2} strokeLinecap="round" />
      <Path
        d="M21 20C21 21.1046 20.1046 22 19 22C17.8954 22 17 21.1046 17 20C17 18.8954 17.8954 18 19 18C20.1046 18 21 18.8954 21 20Z"
        fill={color}
      />
      <Path
        d="M29 25C29 26.1046 28.1046 27 27 27C25.8954 27 25 26.1046 25 25C25 23.8954 25.8954 23 27 23C28.1046 23 29 23.8954 29 25Z"
        fill={color}
      />
      <Path
        d="M23 30C23 31.1046 22.1046 32 21 32C19.8954 32 19 31.1046 19 30C19 28.8954 19.8954 28 21 28C22.1046 28 23 28.8954 23 30Z"
        fill={color}
      />
    </Svg>
  );
}

/** Ellipsis for More. */
export function ProfileMoreIcon({ color = "#FFFFFF", size = 50 }: StrokeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 50 50" fill="none">
      <Path
        d="M17 25C17 25.8284 16.3284 26.5 15.5 26.5C14.6716 26.5 14 25.8284 14 25C14 24.1716 14.6716 23.5 15.5 23.5C16.3284 23.5 17 24.1716 17 25Z"
        fill={color}
      />
      <Path
        d="M27.5 25C27.5 25.8284 26.8284 26.5 26 26.5C25.1716 26.5 24.5 25.8284 24.5 25C24.5 24.1716 25.1716 23.5 26 23.5C26.8284 23.5 27.5 24.1716 27.5 25Z"
        fill={color}
      />
      <Path
        d="M38 25C38 25.8284 37.3284 26.5 36.5 26.5C35.6716 26.5 35 25.8284 35 25C35 24.1716 35.6716 23.5 36.5 23.5C37.3284 23.5 38 24.1716 38 25Z"
        fill={color}
      />
    </Svg>
  );
}

export function ProfileLeaveIcon({ color = "#FFFFFF", size = 18 }: StrokeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 18 18" fill="none">
      <Path
        d="M7 3.5H4.5C3.67157 3.5 3 4.17157 3 5V13C3 13.8284 3.67157 14.5 4.5 14.5H7"
        stroke={color}
        strokeWidth={1.2}
        strokeLinecap="round"
      />
      <Path
        d="M10.5 12.5L14 9L10.5 5.5"
        stroke={color}
        strokeWidth={1.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path d="M14 9H7" stroke={color} strokeWidth={1.2} strokeLinecap="round" />
    </Svg>
  );
}

export function ProfileReportIcon({ color = "#FF1111", size = 18 }: StrokeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 18 18" fill="none">
      <Path
        d="M9 2.5L15.5 14.5H2.5L9 2.5Z"
        stroke={color}
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
      <Path d="M9 7V10.5" stroke={color} strokeWidth={1.2} strokeLinecap="round" />
      <Path
        d="M9 12.75C9.41421 12.75 9.75 13.0858 9.75 13.5C9.75 13.9142 9.41421 14.25 9 14.25C8.58579 14.25 8.25 13.9142 8.25 13.5C8.25 13.0858 8.58579 12.75 9 12.75Z"
        fill={color}
      />
    </Svg>
  );
}

export function ProfileSubscribersIcon({ color = "#FFFFFF", size = 18 }: StrokeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 18 18" fill="none">
      <Path
        d="M7 8C8.10457 8 9 7.10457 9 6C9 4.89543 8.10457 4 7 4C5.89543 4 5 4.89543 5 6C5 7.10457 5.89543 8 7 8Z"
        stroke={color}
        strokeWidth={1.2}
      />
      <Path
        d="M11.5 8.5C12.3284 8.5 13 7.82843 13 7C13 6.17157 12.3284 5.5 11.5 5.5"
        stroke={color}
        strokeWidth={1.2}
        strokeLinecap="round"
      />
      <Path
        d="M3.5 13.5C3.5 11.567 5.067 10 7 10C8.933 10 10.5 11.567 10.5 13.5"
        stroke={color}
        strokeWidth={1.2}
        strokeLinecap="round"
      />
      <Path
        d="M12 10.5C13.3807 10.5 14.5 11.6193 14.5 13"
        stroke={color}
        strokeWidth={1.2}
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function ProfileAdminsIcon({ color = "#FFFFFF", size = 18 }: StrokeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 18 18" fill="none">
      <Path
        d="M9 2.5L11.2 4.1L13.8 3.9L14.1 6.5L16.2 8.1L14.8 10.3L15.2 12.9L12.6 13.4L11 15.5L9 14.2L7 15.5L5.4 13.4L2.8 12.9L3.2 10.3L1.8 8.1L3.9 6.5L4.2 3.9L6.8 4.1L9 2.5Z"
        stroke={color}
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
      <Path
        d="M9 6.5C9.82843 6.5 10.5 7.17157 10.5 8C10.5 8.82843 9.82843 9.5 9 9.5C8.17157 9.5 7.5 8.82843 7.5 8C7.5 7.17157 8.17157 6.5 9 6.5Z"
        stroke={color}
        strokeWidth={1.1}
      />
    </Svg>
  );
}
