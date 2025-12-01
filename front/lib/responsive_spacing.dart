import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart'
    show defaultTargetPlatform, TargetPlatform;

/// Helper class for responsive spacing and safe area handling
/// Use this to ensure consistent padding and margins across different devices
class ResponsiveSpacing {
  // Standard padding values based on screen width (all divisible by 5)
  static const double paddingSmall = 10.0; // < 375px width
  static const double paddingMedium = 15.0; // 375-414px width
  static const double paddingLarge = 20.0; // >= 414px width (capped at 20px)
  static const double paddingXLarge =
      20.0; // > 600px width (capped at 20px for horizontal)

  // Component-specific spacing (all divisible by 5)
  static const double buttonPaddingVertical = 15.0;
  static const double buttonPaddingHorizontal = 20.0;
  static const double cardPadding = 15.0;
  static const double listItemSpacing = 10.0;
  static const double sectionSpacing = 25.0;

  /// Get responsive horizontal padding based on screen width
  /// Returns 20px for screens >= 414px width as requested
  static double getPadding(BuildContext context) {
    final width = MediaQuery.of(context).size.width;
    if (width < 375) return paddingSmall;
    if (width < 414) return paddingMedium;
    return paddingLarge; // 20px for all screens >= 414px
  }

  /// Get responsive padding for all sides
  static EdgeInsets getPaddingAll(BuildContext context) {
    final padding = getPadding(context);
    return EdgeInsets.all(padding);
  }

  /// Get responsive horizontal padding only
  static EdgeInsets getPaddingHorizontal(BuildContext context) {
    final padding = getPadding(context);
    return EdgeInsets.symmetric(horizontal: padding);
  }

  /// Get responsive vertical padding only
  static EdgeInsets getPaddingVertical(BuildContext context) {
    final padding = getPadding(context);
    return EdgeInsets.symmetric(vertical: padding);
  }

  /// Get screen padding with safe area insets
  /// Includes top safe area (for notch/Dynamic Island) and bottom safe area (for home indicator)
  static EdgeInsets getScreenPadding(BuildContext context) {
    final padding = MediaQuery.of(context).padding;
    final horizontal = getPadding(context);
    return EdgeInsets.only(
      top: padding.top + paddingMedium,
      bottom: padding.bottom + paddingMedium,
      left: horizontal,
      right: horizontal,
    );
  }

  /// Get top padding with safe area (for headers, app bars)
  static EdgeInsets getTopPadding(BuildContext context) {
    final padding = MediaQuery.of(context).padding;
    final horizontal = getPadding(context);
    return EdgeInsets.only(
      top: padding.top + paddingMedium,
      left: horizontal,
      right: horizontal,
      bottom: paddingMedium,
    );
  }

  /// Get bottom padding with safe area (for bottom sheets, fixed bottom elements)
  static EdgeInsets getBottomPadding(BuildContext context) {
    final padding = MediaQuery.of(context).padding;
    final horizontal = getPadding(context);
    return EdgeInsets.only(
      top: paddingMedium,
      left: horizontal,
      right: horizontal,
      bottom: padding.bottom + paddingMedium,
    );
  }

  /// Get safe area top inset (status bar + notch/Dynamic Island height)
  static double getSafeAreaTop(BuildContext context) {
    return MediaQuery.of(context).padding.top;
  }

  /// Get safe area bottom inset (home indicator height)
  static double getSafeAreaBottom(BuildContext context) {
    return MediaQuery.of(context).padding.bottom;
  }

  /// Get top padding for TMA logo alignment
  /// On iOS: safe area + 30px (to align with TMA header elements)
  /// On Android: fixed 30px (TMA elements are at fixed height from top)
  static double getTmaLogoTopPadding(BuildContext context) {
    final isIOS = defaultTargetPlatform == TargetPlatform.iOS;
    final isAndroid = defaultTargetPlatform == TargetPlatform.android;

    if (isIOS) {
      // iOS: TMA elements respect safe area, so add safe area + 30px
      return MediaQuery.of(context).padding.top + 30.0;
    } else if (isAndroid) {
      // Android: TMA elements are at fixed height from top, use 30px
      return 30.0;
    } else {
      // Web or other platforms: use safe area + 30px as fallback
      return MediaQuery.of(context).padding.top + 30.0;
    }
  }

  /// Get safe area left inset (for landscape on some devices)
  static double getSafeAreaLeft(BuildContext context) {
    return MediaQuery.of(context).padding.left;
  }

  /// Get safe area right inset (for landscape on some devices)
  static double getSafeAreaRight(BuildContext context) {
    return MediaQuery.of(context).padding.right;
  }

  /// Check if device is a small screen (< 375px width)
  static bool isSmallScreen(BuildContext context) {
    return MediaQuery.of(context).size.width < 375;
  }

  /// Check if device is a medium screen (375-414px width)
  static bool isMediumScreen(BuildContext context) {
    final width = MediaQuery.of(context).size.width;
    return width >= 375 && width < 414;
  }

  /// Check if device is a large screen (414-600px width)
  static bool isLargeScreen(BuildContext context) {
    final width = MediaQuery.of(context).size.width;
    return width >= 414 && width < 600;
  }

  /// Check if device is an extra large screen (>= 600px width, tablets, foldables)
  static bool isXLargeScreen(BuildContext context) {
    return MediaQuery.of(context).size.width >= 600;
  }

  /// Get responsive font size multiplier
  /// Returns 1.0 for standard, 0.9 for small screens, 1.1 for large screens
  static double getFontSizeMultiplier(BuildContext context) {
    if (isSmallScreen(context)) return 0.9;
    if (isXLargeScreen(context)) return 1.1;
    return 1.0;
  }

  /// Get responsive button padding
  static EdgeInsets getButtonPadding(BuildContext context) {
    return const EdgeInsets.symmetric(
      vertical: buttonPaddingVertical,
      horizontal: buttonPaddingHorizontal,
    );
  }

  /// Get card padding
  static EdgeInsets getCardPadding(BuildContext context) {
    final padding = getPadding(context);
    return EdgeInsets.all(padding);
  }

  /// Get section spacing (vertical spacing between sections)
  static double getSectionSpacing(BuildContext context) {
    if (isSmallScreen(context)) return sectionSpacing * 0.75;
    if (isXLargeScreen(context)) return sectionSpacing * 1.25;
    return sectionSpacing;
  }

  /// Get list item spacing
  static double getListItemSpacing(BuildContext context) {
    if (isSmallScreen(context)) return listItemSpacing * 0.75;
    return listItemSpacing;
  }

  /// Check if device is in landscape orientation
  static bool isLandscape(BuildContext context) {
    return MediaQuery.of(context).orientation == Orientation.landscape;
  }

  /// Get screen width
  static double getScreenWidth(BuildContext context) {
    return MediaQuery.of(context).size.width;
  }

  /// Get screen height
  static double getScreenHeight(BuildContext context) {
    return MediaQuery.of(context).size.height;
  }

  /// Get available height (screen height minus safe areas)
  static double getAvailableHeight(BuildContext context) {
    final size = MediaQuery.of(context).size;
    final padding = MediaQuery.of(context).padding;
    return size.height - padding.top - padding.bottom;
  }

  /// Get available width (screen width minus safe areas)
  static double getAvailableWidth(BuildContext context) {
    final size = MediaQuery.of(context).size;
    final padding = MediaQuery.of(context).padding;
    return size.width - padding.left - padding.right;
  }
}

/// Extension methods for easier access to responsive spacing
extension ResponsiveSpacingExtension on BuildContext {
  /// Get responsive padding
  double get responsivePadding => ResponsiveSpacing.getPadding(this);

  /// Get safe area top
  double get safeAreaTop => ResponsiveSpacing.getSafeAreaTop(this);

  /// Get safe area bottom
  double get safeAreaBottom => ResponsiveSpacing.getSafeAreaBottom(this);

  /// Check if small screen
  bool get isSmallScreen => ResponsiveSpacing.isSmallScreen(this);

  /// Check if large screen
  bool get isXLargeScreen => ResponsiveSpacing.isXLargeScreen(this);

  /// Get screen width
  double get screenWidth => ResponsiveSpacing.getScreenWidth(this);

  /// Get screen height
  double get screenHeight => ResponsiveSpacing.getScreenHeight(this);
}
