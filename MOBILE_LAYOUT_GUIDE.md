# Mobile Layout Differences & Development Guide

## Overview
This guide covers key differences between popular mobile devices and browsers, and provides recommendations for padding, margins, and responsive design in your Flutter/Telegram Mini App.

---

## 1. Popular Mobile Device Categories

### iPhone Models
- **iPhone SE (1st/2nd gen)**: 375×667px, 4.7" screen, no notch
- **iPhone 8/7/6s**: 375×667px, 4.7" screen, no notch
- **iPhone X/11 Pro/12 mini/13 mini**: 375×812px, 5.8" screen, **notch + safe area**
- **iPhone 11/XR**: 414×896px, 6.1" screen, **notch + safe area**
- **iPhone 12/13/14**: 390×844px, 6.1" screen, **notch + safe area**
- **iPhone 12/13/14 Pro Max**: 428×926px, 6.7" screen, **notch + safe area**
- **iPhone 14 Pro/15 Pro**: 393×852px, 6.1" screen, **Dynamic Island**
- **iPhone 15/15 Plus**: 393×852px / 430×932px, **Dynamic Island**

### Android Devices
- **Small phones**: 360×640px - 375×667px (older devices)
- **Standard phones**: 360×800px - 414×896px (most common)
- **Large phones**: 412×915px - 430×932px (Galaxy S series, Pixel)
- **Foldables**: Variable (Samsung Galaxy Fold, Pixel Fold)

### Key Differences
1. **Notches/Dynamic Island**: iPhone X and later have top safe areas (44-59px)
2. **Bottom safe area**: iPhone X+ has bottom home indicator (34px)
3. **Status bar height**: Varies (20-44px typically)
4. **Screen density**: 1x, 2x, 3x (affects pixel density, not layout)

---

## 2. Safe Areas & Notches

### iPhone Safe Areas
```
┌─────────────────────────┐
│  Status Bar (44-59px)   │ ← Safe area top
│  ┌───────────────────┐  │
│  │                   │  │
│  │   Content Area    │  │
│  │                   │  │
│  └───────────────────┘  │
│  Home Indicator (34px)  │ ← Safe area bottom
└─────────────────────────┘
```

### Android Notches
- Most Android phones have **no notch** (status bar only)
- Some have **punch-hole cameras** (smaller safe area needed)
- **Foldables** have unique aspect ratios

---

## 3. Browser & WebView Differences

### Safari (iOS)
- **Status bar**: 20-44px (varies by device)
- **Bottom bar**: Can appear/disappear (affects viewport)
- **Safe area insets**: CSS `env(safe-area-inset-*)` available
- **Viewport units**: `100vh` includes address bar (problematic)

### Chrome (Android)
- **Status bar**: 24-48px typically
- **Address bar**: Collapsible (affects viewport height)
- **No safe area insets**: Need manual handling

### Telegram WebView
- **Full screen**: Usually no browser chrome
- **Safe areas**: Depends on device (iPhone = yes, Android = minimal)
- **Viewport**: More predictable than browsers

---

## 4. Recommended Padding & Margins

### Flutter-Specific Values

#### Standard Padding (Content)
```dart
// Small screens (< 375px width)
const double paddingSmall = 12.0;

// Medium screens (375-414px width)
const double paddingMedium = 16.0;

// Large screens (> 414px width)
const double paddingLarge = 20.0;

// Extra large (tablets, foldables)
const double paddingXLarge = 24.0;
```

#### Safe Area Padding
```dart
// Top safe area (for notches/Dynamic Island)
const double safeAreaTop = 44.0; // iPhone X+
const double safeAreaTopMinimal = 20.0; // Older devices

// Bottom safe area (for home indicator)
const double safeAreaBottom = 34.0; // iPhone X+
const double safeAreaBottomMinimal = 0.0; // Android/older iPhone
```

#### Component-Specific Spacing
```dart
// Button padding
const double buttonPaddingVertical = 12.0;
const double buttonPaddingHorizontal = 24.0;

// Card padding
const double cardPadding = 16.0;

// List item spacing
const double listItemSpacing = 12.0;

// Section spacing
const double sectionSpacing = 24.0;
```

---

## 5. Implementation in Flutter

### Using SafeArea Widget
```dart
SafeArea(
  top: true,    // Respects top safe area (notch)
  bottom: true, // Respects bottom safe area (home indicator)
  child: YourContent(),
)
```

### Using MediaQuery for Responsive Design
```dart
// Get screen dimensions
final size = MediaQuery.of(context).size;
final width = size.width;
final height = size.height;

// Get safe area insets
final padding = MediaQuery.of(context).padding;
final topPadding = padding.top;    // Status bar + notch
final bottomPadding = padding.bottom; // Home indicator

// Responsive padding based on screen width
double getResponsivePadding(BuildContext context) {
  final width = MediaQuery.of(context).size.width;
  if (width < 375) return 12.0;
  if (width < 414) return 16.0;
  if (width < 600) return 20.0;
  return 24.0;
}
```

### Using LayoutBuilder for Adaptive Layouts
```dart
LayoutBuilder(
  builder: (context, constraints) {
    if (constraints.maxWidth < 375) {
      // Small phone layout
      return SmallLayout();
    } else if (constraints.maxWidth < 600) {
      // Standard phone layout
      return StandardLayout();
    } else {
      // Tablet/large screen layout
      return LargeLayout();
    }
  },
)
```

---

## 6. Device-Specific Considerations

### iPhone (iOS)
✅ **Must handle:**
- Safe area insets (top: 44-59px, bottom: 34px)
- Dynamic Island (iPhone 14 Pro+)
- Status bar height variations
- Landscape orientation (different safe areas)

✅ **Recommended:**
```dart
Container(
  padding: EdgeInsets.only(
    top: MediaQuery.of(context).padding.top + 16,
    bottom: MediaQuery.of(context).padding.bottom + 16,
    left: 16,
    right: 16,
  ),
  child: YourContent(),
)
```

### Android
✅ **Must handle:**
- Variable status bar heights (20-48px)
- No bottom safe area (usually)
- Wide variety of screen sizes
- Foldable devices (variable aspect ratios)

✅ **Recommended:**
```dart
Container(
  padding: EdgeInsets.only(
    top: MediaQuery.of(context).padding.top + 16,
    bottom: 16, // Usually no bottom safe area
    left: 16,
    right: 16,
  ),
  child: YourContent(),
)
```

### Telegram Mini App Specific
✅ **Consider:**
- Telegram WebView may have its own header
- Full-screen mode availability
- Platform detection (iOS vs Android)
- Viewport height may be more stable than browsers

---

## 7. Common Layout Patterns

### Full-Screen Layout with Safe Areas
```dart
Scaffold(
  body: SafeArea(
    child: Padding(
      padding: EdgeInsets.symmetric(
        horizontal: getResponsivePadding(context),
        vertical: 16,
      ),
      child: YourContent(),
    ),
  ),
)
```

### Fixed Header with Safe Area
```dart
Column(
  children: [
    Container(
      padding: EdgeInsets.only(
        top: MediaQuery.of(context).padding.top,
        left: 16,
        right: 16,
        bottom: 12,
      ),
      child: YourHeader(),
    ),
    Expanded(
      child: YourContent(),
    ),
  ],
)
```

### Bottom Sheet with Safe Area
```dart
Container(
  padding: EdgeInsets.only(
    bottom: MediaQuery.of(context).padding.bottom + 16,
    left: 16,
    right: 16,
    top: 16,
  ),
  child: YourBottomSheetContent(),
)
```

---

## 8. Testing Checklist

### Devices to Test
- [ ] iPhone SE (small screen, no notch)
- [ ] iPhone 12/13 (standard notch)
- [ ] iPhone 14 Pro (Dynamic Island)
- [ ] iPhone 14 Pro Max (large screen)
- [ ] Android small (360×640)
- [ ] Android standard (375×800)
- [ ] Android large (412×915)
- [ ] Landscape orientation

### Browsers/Environments
- [ ] Safari (iOS)
- [ ] Chrome (Android)
- [ ] Telegram WebView (iOS)
- [ ] Telegram WebView (Android)
- [ ] Desktop browser (if applicable)

### What to Check
- [ ] Content not hidden behind notch/Dynamic Island
- [ ] Content not hidden behind home indicator
- [ ] Padding consistent across devices
- [ ] Text readable on all screen sizes
- [ ] Buttons/touch targets ≥ 44×44px
- [ ] Landscape orientation works
- [ ] Safe areas respected in all views

---

## 9. Best Practices

### ✅ DO
- Always use `SafeArea` or `MediaQuery.padding` for top/bottom
- Use responsive padding based on screen width
- Test on real devices (simulators may differ)
- Consider landscape orientation
- Use minimum 44×44px touch targets
- Account for keyboard when it appears

### ❌ DON'T
- Hardcode padding values without considering safe areas
- Assume all devices have the same safe area
- Ignore landscape orientation
- Use fixed pixel values for all screen sizes
- Forget about foldable devices (if targeting Android)

---

## 10. Quick Reference: Common Values

| Element | Small Phone | Standard Phone | Large Phone |
|---------|------------|----------------|-------------|
| **Content Padding** | 12px | 16px | 20px |
| **Section Spacing** | 16px | 24px | 32px |
| **Card Padding** | 12px | 16px | 20px |
| **Button Padding** | 12px vertical | 12px vertical | 14px vertical |
| **List Item Spacing** | 8px | 12px | 16px |
| **Top Safe Area** | 20-44px | 44-59px | 44-59px |
| **Bottom Safe Area** | 0-34px | 0-34px | 0-34px |

---

## 11. Flutter Helper Class Example

```dart
class ResponsiveSpacing {
  static double getPadding(BuildContext context) {
    final width = MediaQuery.of(context).size.width;
    if (width < 375) return 12.0;
    if (width < 414) return 16.0;
    if (width < 600) return 20.0;
    return 24.0;
  }

  static EdgeInsets getScreenPadding(BuildContext context) {
    final padding = MediaQuery.of(context).padding;
    final horizontal = getPadding(context);
    return EdgeInsets.only(
      top: padding.top + 16,
      bottom: padding.bottom + 16,
      left: horizontal,
      right: horizontal,
    );
  }

  static double getSafeAreaTop(BuildContext context) {
    return MediaQuery.of(context).padding.top;
  }

  static double getSafeAreaBottom(BuildContext context) {
    return MediaQuery.of(context).padding.bottom;
  }

  static bool isSmallScreen(BuildContext context) {
    return MediaQuery.of(context).size.width < 375;
  }

  static bool isLargeScreen(BuildContext context) {
    return MediaQuery.of(context).size.width >= 600;
  }
}
```

---

## Summary

**Key Takeaways:**
1. **Always respect safe areas** - Use `SafeArea` or `MediaQuery.padding`
2. **Use responsive padding** - Scale based on screen width
3. **Test on real devices** - Simulators may not show all issues
4. **Consider both orientations** - Landscape has different safe areas
5. **Account for browser differences** - Safari vs Chrome vs Telegram WebView
6. **Minimum touch targets** - 44×44px for accessibility

For your Telegram Mini App specifically, focus on:
- Safe area handling for iPhone notches/Dynamic Island
- Responsive padding (12-24px range)
- Testing in Telegram WebView on both iOS and Android
- Handling viewport changes when keyboard appears

