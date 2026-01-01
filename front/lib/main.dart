import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:http/http.dart' as http;
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'dart:convert';
import 'dart:math' as math;
import 'dart:js' as js;
import 'dart:async';
import 'dart:ui' as ui show TextDirection;
import 'package:flutter_telegram_miniapp/flutter_telegram_miniapp.dart' as tma;
import 'analytics.dart';
import 'telegram_safe_area.dart';
import 'telegram_webapp.dart';

// Theme helper class
class AppTheme {
  static final ValueNotifier<String?> _colorSchemeNotifier = ValueNotifier<String?>(null);
  
  static ValueNotifier<String?> get colorSchemeNotifier => _colorSchemeNotifier;
  
  /// Initialize theme from Telegram WebApp or browser/system preference
  static void initialize() {
    final telegramWebApp = TelegramWebApp();
    
    // Use console.log directly for browser console visibility
    final console = js.context['console'];
    final log = console != null ? console['log'] : null;
    
    void consoleLog(String message) {
      print(message);
      if (log is js.JsFunction) {
        log.apply([message]);
      }
    }
    
    // Check if we're actually running in Telegram (not just that the script is loaded)
    // The Telegram WebApp script is loaded in HTML, but we need to verify we're actually in Telegram
    final isActuallyInTelegram = telegramWebApp.isActuallyInTelegram;
    
    if (isActuallyInTelegram) {
      // Use Telegram WebApp theme
      final colorScheme = telegramWebApp.colorScheme;
      _colorSchemeNotifier.value = colorScheme;
      consoleLog('[AppTheme] ✓ Initialized with Telegram WebApp colorScheme: $colorScheme');
      
      // Listen for theme changes in real-time
      // According to Telegram docs: when themeChanged event fires,
      // the WebApp object already has updated colorScheme and themeParams
      telegramWebApp.onThemeChanged(() {
        // Immediately read the new colorScheme from Telegram WebApp
        // The WebApp object (this) already contains the updated values
        final newColorScheme = telegramWebApp.colorScheme;
        print('Theme changed event received! New colorScheme: $newColorScheme');
        
        // Update the notifier immediately to trigger UI rebuild
        final oldColorScheme = _colorSchemeNotifier.value;
        if (oldColorScheme != newColorScheme) {
          _colorSchemeNotifier.value = newColorScheme;
          print('Theme updated from "$oldColorScheme" to "$newColorScheme"');
        } else {
          print('Theme value unchanged: $newColorScheme');
        }
      });
      consoleLog('[AppTheme] ✓ Theme change listener registered');
    } else {
      // Not in Telegram Mini App - use browser/system theme
      // Wrap in try-catch to prevent errors from breaking app initialization
      try {
        consoleLog('[AppTheme] Not in Telegram, initializing browser theme...');
        _initializeBrowserTheme();
      } catch (e) {
        // If browser theme detection fails, use default theme
        print('[AppTheme] Error initializing browser theme: $e');
        _colorSchemeNotifier.value = 'light'; // Default fallback
      }
    }
  }
  
  /// Initialize theme from browser/system preference
  static void _initializeBrowserTheme() {
    try {
      // Use console.log directly for browser console visibility
      final console = js.context['console'];
      final log = console != null ? console['log'] : null;
      
      void consoleLog(String message) {
        print(message);
        if (log is js.JsFunction) {
          log.apply([message]);
        }
      }
      
      consoleLog('[AppTheme] Initializing browser theme detection...');
      // Use JavaScript to detect browser/system theme preference
      // Priority: browser prefers-color-scheme > system
      try {
        // Use a simpler approach: call window.matchMedia directly via JS
        // Create a JS function that calls window.matchMedia
        final matchMediaCode = '''
          (function(query) {
            if (typeof window !== 'undefined' && window.matchMedia) {
              return window.matchMedia(query);
            }
            return null;
          })
        ''';
        
        final matchMediaFunc = js.context.callMethod('eval', [matchMediaCode]);
        
        if (matchMediaFunc == null || matchMediaFunc is! js.JsFunction) {
          consoleLog('[AppTheme] matchMedia function not available, using default dark theme');
          _colorSchemeNotifier.value = 'dark';
          return;
        }
        
        // Check for prefers-color-scheme media query
        consoleLog('[AppTheme] Calling matchMedia for dark mode...');
        final darkModeQuery = matchMediaFunc.apply(['(prefers-color-scheme: dark)']);
        consoleLog('[AppTheme] Dark mode query result: $darkModeQuery');
        
        if (darkModeQuery == null || darkModeQuery is! js.JsObject) {
          consoleLog('[AppTheme] Dark mode query failed, using default dark theme');
          _colorSchemeNotifier.value = 'dark';
          return;
        }
        
        final isDark = darkModeQuery['matches'];
        consoleLog('[AppTheme] Dark mode matches: $isDark');
        
        String detectedTheme;
        if (isDark == true) {
          detectedTheme = 'dark';
        } else {
          // Check light mode explicitly
          consoleLog('[AppTheme] Calling matchMedia for light mode...');
          final lightModeQuery = matchMediaFunc.apply(['(prefers-color-scheme: light)']);
          consoleLog('[AppTheme] Light mode query result: $lightModeQuery');
          
          if (lightModeQuery != null && lightModeQuery is js.JsObject && lightModeQuery['matches'] == true) {
            detectedTheme = 'light';
          } else {
            // Default to dark if no preference
            detectedTheme = 'dark';
          }
        }
        
        _colorSchemeNotifier.value = detectedTheme;
        consoleLog('[AppTheme] ✓ Theme set to: $detectedTheme');
        
        // Listen for theme changes using addEventListener (modern approach)
        final addEventListener = darkModeQuery['addEventListener'];
        if (addEventListener is js.JsFunction) {
          addEventListener.apply([
            'change',
            js.allowInterop((js.JsObject e) {
                    final target = e['target'];
                    final isDark = target != null && target is js.JsObject
                        ? target['matches'] == true
                        : (darkModeQuery['matches'] == true);
                    final newTheme = isDark ? 'dark' : 'light';
                    consoleLog('[AppTheme] 🔄 Browser theme changed to: $newTheme');
                    _colorSchemeNotifier.value = newTheme;
                  })
                ]);
          consoleLog('[AppTheme] ✓ Theme change listener registered (addEventListener)');
        } else {
          // Fallback to addListener (older browsers)
          final addListener = darkModeQuery['addListener'];
          if (addListener is js.JsFunction) {
            addListener.apply([
              js.allowInterop((js.JsObject e) {
                final isDark = e['matches'] == true;
                final newTheme = isDark ? 'dark' : 'light';
                consoleLog('[AppTheme] 🔄 Browser theme changed to: $newTheme');
                _colorSchemeNotifier.value = newTheme;
              })
            ]);
            consoleLog('[AppTheme] ✓ Theme change listener registered (addListener)');
          } else {
            consoleLog('[AppTheme] ⚠ Could not register theme change listener');
          }
        }
      } catch (e) {
        // Fallback: default to dark theme on any error
        _colorSchemeNotifier.value = 'dark';
        consoleLog('[AppTheme] ⚠ Error initializing browser theme: $e, defaulting to dark');
      }
    } catch (e, stackTrace) {
      // Fallback: default to dark theme
      _colorSchemeNotifier.value = 'dark';
      final console = js.context['console'];
      final log = console != null ? console['log'] : null;
      if (log is js.JsFunction) {
        log.apply(['[AppTheme] ❌ Error initializing theme: $e']);
        log.apply(['[AppTheme] Stack trace: $stackTrace']);
      }
      print('[AppTheme] ❌ Error initializing theme: $e');
      print('[AppTheme] Stack trace: $stackTrace');
    }
  }
  
  /// Manually refresh theme from Telegram WebApp or browser/system (useful for debugging or manual refresh)
  static void refreshTheme() {
    final telegramWebApp = TelegramWebApp();
    if (telegramWebApp.isActuallyInTelegram) {
      final colorScheme = telegramWebApp.colorScheme;
      if (_colorSchemeNotifier.value != colorScheme) {
        print('Manually refreshing theme to: $colorScheme');
        _colorSchemeNotifier.value = colorScheme;
      }
    } else {
      // Refresh browser theme
      _initializeBrowserTheme();
    }
  }
  
  /// Get current color scheme from Telegram, browser/system, or env variable
  static String? get _currentColorScheme {
    final telegramWebApp = TelegramWebApp();
    
    // Priority 1: Telegram WebApp theme
    if (telegramWebApp.isActuallyInTelegram) {
      final colorScheme = telegramWebApp.colorScheme;
      if (colorScheme != null) {
        return colorScheme;
      }
    }
    
    // Priority 2: Browser/system theme (if notifier already has a value)
    if (_colorSchemeNotifier.value != null) {
      return _colorSchemeNotifier.value;
    }
    
    // Priority 3: Detect browser/system theme on the fly
    try {
      final window = js.context['window'];
      if (window != null) {
        final matchMedia = window['matchMedia'];
        if (matchMedia is js.JsFunction) {
          final darkModeQuery = matchMedia.apply(['(prefers-color-scheme: dark)']);
          if (darkModeQuery != null && darkModeQuery['matches'] == true) {
            return 'dark';
          }
          final lightModeQuery = matchMedia.apply(['(prefers-color-scheme: light)']);
          if (lightModeQuery != null && lightModeQuery['matches'] == true) {
            return 'light';
          }
        }
      }
    } catch (e) {
      // Ignore errors
    }
    
    // Priority 4: Fallback to env variable for local development
    return dotenv.env['THEME'];
  }
  
  static bool get isLightTheme {
    final colorScheme = _colorSchemeNotifier.value ?? _currentColorScheme;
    return colorScheme?.toLowerCase() == 'light';
  }

  static bool get isDarkTheme => !isLightTheme;

  // Base colors for dark theme (black variations)
  static const List<Color> darkBaseColors = [
    Color(0xFF010101),
    Color(0xFF010102),
    Color(0xFF010103),
    Color(0xFF010104),
    Color(0xFF010105),
    Color(0xFF010106),
  ];

  // Base colors for light theme (white variations)
  static const List<Color> lightBaseColors = [
    Color(0xFFFFFFFE),
    Color(0xFFFFFFFD),
    Color(0xFFFFFFFC),
    Color(0xFFFFFFFB),
    Color(0xFFFFFFFA),
    Color(0xFFFFFFF9),
  ];

  static List<Color> get baseColors =>
      isLightTheme ? lightBaseColors : darkBaseColors;

  static Color get backgroundColor =>
      isLightTheme ? Colors.white : Colors.black;

  static Color get textColor => isLightTheme ? Colors.black : Colors.white;

  static Color get chartLineColor => isLightTheme ? Colors.black : Colors.white;

  static Color get dotFillColor => isLightTheme ? Colors.white : Colors.black;

  static Color get dotStrokeColor => isLightTheme ? Colors.black : Colors.white;

  static Color get buttonBackgroundColor =>
      isLightTheme ? Colors.black : Colors.white;

  static Color get buttonTextColor =>
      isLightTheme ? Colors.white : Colors.black;

  static Color get radialGradientColor =>
      isLightTheme ? const Color(0xFFFFFFFF) : const Color(0xFF06050A);

  static Color get overlayColor => isLightTheme ? Colors.white : Colors.black;
}

class DiagonalLinePainter extends CustomPainter {
  final List<double>? dataPoints; // Optional: for real data later
  final int? selectedPointIndex;

  DiagonalLinePainter({this.dataPoints, this.selectedPointIndex});

  @override
  void paint(Canvas canvas, Size size) {
    if (size.width == 0 || size.height == 0) return;

    // Don't draw anything if no real data is provided
    if (dataPoints == null || dataPoints!.isEmpty) return;

    final paint = Paint()
      ..color = AppTheme.chartLineColor
      ..strokeWidth = 1.33
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;

    final path = Path();

    // Use only real data - no sample points
    final points = dataPoints!;

    if (points.isEmpty) return;

    // Calculate step size to ensure all points are distributed across full width
    // Always use full width regardless of number of points
    final pointCount = points.length;
    final stepSize = pointCount > 1 ? size.width / (pointCount - 1) : 0.0;

    // Start the path at the first point (x=0, always)
    // Y coordinate: higher normalized values (maxPrice = 1.0) should be at top (y=0)
    // Lower normalized values (minPrice = 0.0) should be at bottom (y=height)
    // So we invert: y = height - (normalizedValue * height)
    final startY = size.height - (points[0] * size.height);
    path.moveTo(0, startY);

    // Handle single point case - draw a horizontal line
    if (pointCount == 1) {
      path.lineTo(size.width, startY);
    } else {
      // Create smooth curve through all points using cubic bezier
      // Always distribute all points across the full width
      for (int i = 1; i < pointCount; i++) {
        // Calculate x position: always span from 0 to full width
        final x = i * stepSize;
        // Invert Y so higher values appear at top
        final y = size.height - (points[i] * size.height);

        if (i == 1) {
          // First segment: use quadratic curve
          final controlX = x * 0.5;
          final controlY = size.height -
              (points[0] * size.height) * 0.7 -
              (points[i] * size.height) * 0.3;
          path.quadraticBezierTo(controlX, controlY, x, y);
        } else {
          // Subsequent segments: use cubic bezier for smooth transitions
          final prevX = (i - 1) * stepSize;
          final prevY = size.height - (points[i - 1] * size.height);

          // Control points for smooth curve
          final cp1X = prevX + (x - prevX) * 0.3;
          final cp1Y = prevY;
          final cp2X = prevX + (x - prevX) * 0.7;
          final cp2Y = y;

          path.cubicTo(cp1X, cp1Y, cp2X, cp2Y, x, y);
        }
      }

      // Ensure the last point reaches the full width
      if (pointCount > 1) {
        final lastX = (pointCount - 1) * stepSize;
        if (lastX < size.width) {
          final lastY = size.height - (points[pointCount - 1] * size.height);
          path.lineTo(size.width, lastY);
        }
      }
    }

    canvas.drawPath(path, paint);

    // Draw selected point highlight if a point is selected
    if (selectedPointIndex != null &&
        selectedPointIndex! >= 0 &&
        selectedPointIndex! < pointCount) {
      final selectedX = selectedPointIndex! * stepSize;
      final selectedY =
          size.height - (points[selectedPointIndex!] * size.height);

      // Draw 5px black square with 1.33px white stroke
      const squareSize = 5.0;
      final squareRect = RRect.fromRectAndRadius(
        Rect.fromCenter(
          center: Offset(selectedX, selectedY),
          width: squareSize,
          height: squareSize,
        ),
        Radius.zero,
      );

      // Draw fill
      final fillPaint = Paint()
        ..color = AppTheme.dotFillColor
        ..style = PaintingStyle.fill;
      canvas.drawRRect(squareRect, fillPaint);

      // Draw stroke
      final strokePaint = Paint()
        ..color = AppTheme.dotStrokeColor
        ..strokeWidth = 1.33
        ..style = PaintingStyle.stroke;
      canvas.drawRRect(squareRect, strokePaint);
    }
  }

  @override
  bool shouldRepaint(DiagonalLinePainter oldDelegate) {
    return oldDelegate.dataPoints != dataPoints ||
        oldDelegate.selectedPointIndex != selectedPointIndex;
  }
}

// Helper class for Telegram WebApp BackButton
// Uses raw Telegram WebApp API following event-based pattern:
// - postEvent('web_app_setup_back_button') to show/hide
// - onEvent('back_button_pressed') to listen to clicks
class TelegramBackButton {
  // Store callback references so offClick can properly remove them
  static final Map<Function(), dynamic> _callbackMap = {};

  // CRITICAL: Store callbacks globally to prevent garbage collection
  static final List<dynamic> _globalCallbacks = [];
  
  // Log collector for displaying logs on screen
  static final List<String> _logs = [];
  static final _logController = StreamController<String>.broadcast();
  
  /// Stream of log messages
  static Stream<String> get logStream => _logController.stream;
  
  /// Get recent logs
  static List<String> get recentLogs => List.unmodifiable(_logs);
  
  /// Add a log message (both to console and log list)
  static void addLog(String message) {
    _addLog(message);
  }
  
  static void _addLog(String message) {
    print(message); // Also print to console
    final timestamp = DateTime.now().toString().substring(11, 19);
    final logMessage = '[$timestamp] $message';
    _logs.add(logMessage);
    if (_logs.length > 50) {
      _logs.removeAt(0); // Keep only last 50 logs
    }
    _logController.add(logMessage);
  }

  /// Get the WebApp instance
  static js.JsObject? _getWebApp() {
    try {
      final telegram = js.context['Telegram'];
      if (telegram == null) {
        _addLog('[BackButton] Telegram object not found');
        return null;
      }
      final webApp = telegram['WebApp'];
      if (webApp == null) {
        _addLog('[BackButton] WebApp object not found');
        return null;
      }
      if (webApp is! js.JsObject) {
        _addLog('[BackButton] WebApp is not a JsObject: ${webApp.runtimeType}');
        return null;
      }
      return webApp;
    } catch (e) {
      _addLog('[BackButton] Error getting WebApp: $e');
      return null;
    }
  }

  /// Get the BackButton object from WebApp
  static js.JsObject? _getBackButton() {
    try {
      final webApp = _getWebApp();
      if (webApp == null) return null;

      final backButton = webApp['BackButton'];
      if (backButton == null) {
        _addLog('[BackButton] BackButton object not found');
        return null;
      }
      if (backButton is! js.JsObject) {
        _addLog('[BackButton] BackButton is not a JsObject: ${backButton.runtimeType}');
        return null;
      }
      return backButton;
    } catch (e) {
      _addLog('[BackButton] Error getting BackButton: $e');
      return null;
    }
  }

  /// Setup a debug listener to catch all events (for troubleshooting)
  /// Also sets up window message listener to catch events from Telegram
  static void setupDebugEventListener() {
    try {
      final webApp = _getWebApp();
      if (webApp == null) {
        _addLog('[BackButton] Debug: WebApp not found for event listener');
        return;
      }

      final onEvent = webApp['onEvent'];
      if (onEvent != null && onEvent is js.JsFunction) {
        // Listen to back button events specifically
        final debugCallback = js.allowInterop((dynamic eventData) {
          _addLog('[BackButton] 🔍 DEBUG: Event callback triggered! Event data: $eventData');
        });

        // Try listening to the back_button_pressed event
        try {
          onEvent.apply(['back_button_pressed', debugCallback]);
          _addLog('[BackButton] Debug: Registered listener for "back_button_pressed"');
        } catch (e) {
          _addLog('[BackButton] Debug: Failed to register "back_button_pressed": $e');
        }
        
        // Also try backButtonClicked
        try {
          onEvent.apply(['backButtonClicked', debugCallback]);
          _addLog('[BackButton] Debug: Registered listener for "backButtonClicked"');
        } catch (e) {
          _addLog('[BackButton] Debug: Failed to register "backButtonClicked": $e');
        }
      }
      
      // Window message listener removed temporarily to debug page loading
    } catch (e) {
      _addLog('[BackButton] Debug: Error setting up debug listener: $e');
    }
  }

  /// Show the back button
  /// First tries BackButton.show(), then falls back to postEvent
  static void show() {
    try {
      final webApp = _getWebApp();
      if (webApp == null) {
        _addLog('[BackButton] WebApp not found');
        return;
      }

      // Method 1: Try using BackButton.show() directly (primary method)
    final backButton = _getBackButton();
    if (backButton != null) {
        final showMethod = backButton['show'];
        if (showMethod != null && showMethod is js.JsFunction) {
          try {
            showMethod.apply([]);
            _addLog('[BackButton] ✓ Show command sent via BackButton.show()');
            return;
          } catch (e) {
            _addLog('[BackButton] BackButton.show() failed: $e');
            // Fall through to postEvent
          }
        }
      }

      // Method 2: Fallback to postEvent
      final postEvent = webApp['postEvent'];
      if (postEvent != null && postEvent is js.JsFunction) {
        try {
          postEvent.apply([
            'web_app_setup_back_button',
            js.JsObject.jsify({'is_visible': true})
          ]);
          _addLog('[BackButton] ✓ Show command sent via postEvent (fallback)');
          return;
      } catch (e) {
          _addLog('[BackButton] postEvent failed: $e');
      }
      }

      _addLog('[BackButton] ✗ Could not show back button - no methods available');
    } catch (e) {
      _addLog('[BackButton] Error showing back button: $e');
    }
  }

  /// Hide the back button
  /// First tries BackButton.hide(), then falls back to postEvent
  static void hide() {
    try {
      final webApp = _getWebApp();
      if (webApp == null) {
        _addLog('[BackButton] WebApp not found');
        return;
      }

      // Method 1: Try using BackButton.hide() directly (primary method)
    final backButton = _getBackButton();
    if (backButton != null) {
        final hideMethod = backButton['hide'];
        if (hideMethod != null && hideMethod is js.JsFunction) {
          try {
            hideMethod.apply([]);
            _addLog('[BackButton] ✓ Hide command sent via BackButton.hide()');
            return;
          } catch (e) {
            _addLog('[BackButton] BackButton.hide() failed: $e');
            // Fall through to postEvent
          }
        }
      }

      // Method 2: Fallback to postEvent
      final postEvent = webApp['postEvent'];
      if (postEvent != null && postEvent is js.JsFunction) {
        try {
          postEvent.apply([
            'web_app_setup_back_button',
            js.JsObject.jsify({'is_visible': false})
          ]);
          _addLog('[BackButton] ✓ Hide command sent via postEvent (fallback)');
          return;
      } catch (e) {
          _addLog('[BackButton] postEvent failed: $e');
        }
      }

      _addLog('[BackButton] ✗ Could not hide back button - no methods available');
    } catch (e) {
      _addLog('[BackButton] Error hiding back button: $e');
    }
  }

  /// Register a callback for back button clicks
  /// Uses new JS interop API for better type safety
  /// Tries multiple methods:
  /// 1. BackButton.onClick() - Direct Telegram API
  /// 2. WebApp.onEvent('back_button_pressed') - Event-based (matches tma.js)
  /// 3. Window message listener - Catches postMessage events (backup)
  static void onClick(Function() callback) {
    try {
      // Remove any existing callback for this function to avoid duplicates
      if (_callbackMap.containsKey(callback)) {
        offClick(callback);
      }

      // Create a unique callback ID for storing on window
      final callbackId = 'telegram_back_btn_${DateTime.now().millisecondsSinceEpoch}';
      
      // Create Dart callback using js.allowInterop
      final dartCallback = js.allowInterop((dynamic event) {
        _addLog('[BackButton] 🔔🔔🔔🔔🔔 CALLBACK FIRED! 🔔🔔🔔🔔🔔');
        _addLog('[BackButton] Event: $event');
        _addLog('[BackButton] Executing handler...');
        try {
            callback();
          _addLog('[BackButton] ✓ Handler executed successfully');
        } catch (e, stackTrace) {
          _addLog('[BackButton] ✗ Error in handler: $e');
          _addLog('[BackButton] Stack: $stackTrace');
        }
      });
      
      // CRITICAL: Create a NATIVE JavaScript function using eval
      // This ensures Telegram recognizes it as a proper JS function
      dynamic jsNativeCallback;
      try {
        // Step 1: Store Dart callback on window using a helper function
        // Create a storage function first
        js.context.callMethod('eval', [
          '''
          window._storeDartCallback_$callbackId = function(callback) {
            window._dartBackBtnCallback_$callbackId = callback;
          };
          '''
        ]);
        
        // Step 2: Call the storage function with the Dart callback
        final storeFunc = js.context.callMethod('eval', ['window._storeDartCallback_$callbackId']);
        if (storeFunc is js.JsFunction) {
          storeFunc.apply([dartCallback]);
        }
        _addLog('[BackButton] Stored Dart callback on window');
        
        // Step 3: Create a native JS function that calls the stored callback
        // Use a local variable to avoid string interpolation issues
        jsNativeCallback = js.context.callMethod('eval', [
          '''
          (function() {
            var id = '$callbackId';
            return function() {
              console.log('[BackButton] Native JS function called!');
              var callbackName = '_dartBackBtnCallback_' + id;
              if (window[callbackName]) {
                window[callbackName]();
              } else {
                console.error('[BackButton] Callback not found on window!');
              }
            };
          })()
          '''
        ]);
        
        _addLog('[BackButton] ✓ Created native JS function wrapper');
        _addLog('[BackButton] Native callback type: ${jsNativeCallback.runtimeType}');
      } catch (e, stackTrace) {
        _addLog('[BackButton] ✗ Could not create native JS function: $e');
        _addLog('[BackButton] Stack: $stackTrace');
        jsNativeCallback = null;
      }
      
      // Also create separate callbacks for event listeners
      final callbackBackButtonPressed = js.allowInterop((dynamic event) {
        _addLog('[BackButton] 🔔 EVENT: back_button_pressed fired!');
        callback();
      });
      
      final callbackBackButtonClicked = js.allowInterop((dynamic event) {
        _addLog('[BackButton] 🔔 EVENT: backButtonClicked fired!');
        callback();
      });

      _addLog('[BackButton] Created JavaScript callbacks');

      final webApp = _getWebApp();
      if (webApp == null) {
        _addLog('[BackButton] WebApp not found - cannot register onClick');
            return;
      }

      // Callback is already stored on window via eval above
      // This prevents garbage collection

      // METHOD 1: BackButton.onClick() via dart:js - PRIMARY for TMA built-in button
      // According to Telegram API: BackButton.onClick() is the direct method
      try {
        final backButton = _getBackButton();
        if (backButton != null) {
          final onClick = backButton['onClick'];
          if (onClick is js.JsFunction) {
            _addLog('[BackButton] Attempting BackButton.onClick() via dart:js...');
            _addLog('[BackButton] This is PRIMARY for TMA built-in button');
            // CRITICAL: Store callback in global list to prevent GC
            _globalCallbacks.add(dartCallback);
            if (jsNativeCallback != null) {
              _globalCallbacks.add(jsNativeCallback);
            }
            
            // Register the callback - use native JS function if available
            _addLog('[BackButton] Calling BackButton.onClick() with callback...');
            
            // Use native JS callback if we created one, otherwise use Dart callback
            final callbackToUse = jsNativeCallback ?? dartCallback;
            _addLog('[BackButton] Using callback type: ${callbackToUse.runtimeType}');
            
            try {
              onClick.apply([callbackToUse]);
              _callbackMap[callback] = callbackToUse;
              _globalCallbacks.add(callbackToUse);
              _addLog('[BackButton] ✓ Handler registered via BackButton.onClick() (METHOD 1 - PRIMARY)');
          } catch (e) {
              _addLog('[BackButton] ✗ onClick.apply() failed: $e');
              // Try alternative - use dartCallback directly
              try {
                onClick.apply([dartCallback]);
                _callbackMap[callback] = dartCallback;
                _globalCallbacks.add(dartCallback);
                _addLog('[BackButton] ✓ Handler registered using dartCallback fallback');
              } catch (e2) {
                _addLog('[BackButton] ✗ All registration methods failed: $e2');
                throw e;
        }
      }

            _addLog('[BackButton] ✓ Handler registered via BackButton.onClick() (METHOD 1 - PRIMARY)');
            _addLog('[BackButton] Callback stored globally (size: ${_globalCallbacks.length})');
            
            // Verify the callback was actually registered
            try {
              // Check if button is visible (should be false before show())
              final isVisible = backButton['isVisible'];
              _addLog('[BackButton] BackButton.isVisible: $isVisible');
            } catch (e) {
              _addLog('[BackButton] Could not check isVisible: $e');
            }
          } else {
            _addLog('[BackButton] ✗ BackButton.onClick is not a function: ${onClick.runtimeType}');
          }
        } else {
          _addLog('[BackButton] ✗ BackButton object not found');
        }
      } catch (e, stackTrace) {
        _addLog('[BackButton] ✗ BackButton.onClick() failed: $e');
        _addLog('[BackButton] Stack: $stackTrace');
      }
      
      // IMPORTANT: For TMA built-in buttons, the callback MUST be registered BEFORE show()
      // Verify this is the case by checking if button is visible
      try {
        final backButton = _getBackButton();
        if (backButton != null) {
          final isVisible = backButton['isVisible'];
          if (isVisible == true) {
            _addLog('[BackButton] ⚠️ WARNING: Button is already visible! Callback should be registered BEFORE show()');
          } else {
            _addLog('[BackButton] ✓ Button not visible yet - callback registered at correct time');
          }
        }
      } catch (e) {
        // Ignore
      }

      // METHOD 2: WebApp.onEvent('backButtonClicked') - Telegram API says this is the event name
      // According to Telegram API docs: BackButton.onClick() is alias for onEvent('backButtonClicked')
      try {
        final onEvent = webApp['onEvent'];
        if (onEvent != null && onEvent is js.JsFunction) {
          _addLog('[BackButton] Attempting WebApp.onEvent("backButtonClicked")...');
          _addLog('[BackButton] Telegram API: BackButton.onClick() = onEvent("backButtonClicked")');
          // Use separate callback to identify which event fires
          onEvent.apply(['backButtonClicked', callbackBackButtonClicked]);
          if (!_callbackMap.containsKey(callback)) {
            _callbackMap[callback] = callbackBackButtonClicked;
          }
          _addLog('[BackButton] ✓ Handler registered via onEvent("backButtonClicked") (METHOD 2)');
        }
      } catch (e) {
        _addLog('[BackButton] ✗ onEvent("backButtonClicked") failed: $e');
      }

      // METHOD 3: Also try 'back_button_pressed' (snake_case - tma.js uses this)
      try {
        final onEvent = webApp['onEvent'];
        if (onEvent != null && onEvent is js.JsFunction) {
          _addLog('[BackButton] Attempting WebApp.onEvent("back_button_pressed")...');
          _addLog('[BackButton] This is what tma.js SDK uses (snake_case)');
          // Use separate callback to identify which event fires
          onEvent.apply(['back_button_pressed', callbackBackButtonPressed]);
          _addLog('[BackButton] ✓ Handler registered via onEvent("back_button_pressed") (METHOD 3)');
        }
      } catch (e) {
        _addLog('[BackButton] ✗ onEvent("back_button_pressed") failed: $e');
      }
      
      // DEBUG: Listen to ALL events to see what Telegram actually sends
      try {
        final onEvent = webApp['onEvent'];
        if (onEvent != null && onEvent is js.JsFunction) {
          final debugAllEvents = js.allowInterop((dynamic eventData) {
            _addLog('[BackButton] 🔍 DEBUG: Received event! Data: $eventData, Type: ${eventData.runtimeType}');
          });
          // Try to listen to all possible event names
          final eventNames = ['back_button_pressed', 'backButtonClicked', 'backButton', 'back'];
          for (final eventName in eventNames) {
            try {
              onEvent.apply([eventName, debugAllEvents]);
              _addLog('[BackButton] Debug: Listening to "$eventName" events');
            } catch (e) {
              // Ignore
            }
        }
      }
    } catch (e) {
        _addLog('[BackButton] Could not set up debug event listeners: $e');
      }

      // METHOD 4: Window message listener (like tma.js bridge)
      // Use eval to create native JS event listener (bypasses dart:js limitations)
      try {
        // Use bracket notation to avoid string concatenation syntax errors
        final messageHandlerCode = '''
          (function() {
            var id = '$callbackId';
            function handleTelegramMessage(event) {
              if (event.source !== window.parent) return;
              var data = event.data;
              if (!data) return;
              
              try {
                var parsed = typeof data === 'string' ? JSON.parse(data) : data;
                if (parsed && parsed.eventType) {
                  console.log('[BackButton] Window message eventType:', parsed.eventType);
                  if (parsed.eventType === 'back_button_pressed' || parsed.eventType === 'backButtonClicked') {
                    console.log('[BackButton] 🔔🔔🔔 WINDOW MESSAGE: ' + parsed.eventType);
                    var callbackName = '_dartBackBtnCallback_' + id;
                    if (window[callbackName]) {
                      window[callbackName]();
                    }
                  }
                }
              } catch (e) {
                // Ignore parse errors
              }
            }
            window.addEventListener('message', handleTelegramMessage, false);
            window['_telegramMessageHandler_' + id] = handleTelegramMessage;
            console.log('[BackButton] Window message listener registered');
          })();
        ''';
        
        js.context.callMethod('eval', [messageHandlerCode]);
        _addLog('[BackButton] ✓ Window message listener registered via eval (METHOD 4)');
      } catch (e, stackTrace) {
        _addLog('[BackButton] Could not set up window message listener: $e');
        _addLog('[BackButton] Stack: $stackTrace');
      }

    } catch (e, stackTrace) {
      _addLog('[BackButton] ✗ Error setting up onClick: $e');
      _addLog('[BackButton] Stack trace: $stackTrace');
    }
  }

  /// Remove a callback for back button clicks
  /// Uses offEvent('back_button_pressed') to match tma.js SDK
  static void offClick(Function() callback) {
    try {
      final jsCallback = _callbackMap[callback];
      if (jsCallback == null) {
        _addLog('[BackButton] No callback found to remove');
        return;
      }

      final webApp = _getWebApp();
      if (webApp == null) {
        _addLog('[BackButton] WebApp not found - cannot remove onClick');
        return;
      }

      // Use offEvent('back_button_pressed') - matches tma.js SDK
        final offEvent = webApp['offEvent'];
      if (offEvent != null && offEvent is js.JsFunction) {
        try {
          offEvent.apply(['back_button_pressed', jsCallback]);
          _callbackMap.remove(callback);
          _addLog('[BackButton] ✓ Handler removed via offEvent("back_button_pressed")');
          return;
        } catch (e) {
          _addLog('[BackButton] offEvent("back_button_pressed") failed: $e');
        }
      } else {
        _addLog('[BackButton] ✗ offEvent method not found');
      }

      _addLog('[BackButton] ✗ Could not remove onClick');
    } catch (e) {
      _addLog('[BackButton] Error removing onClick: $e');
    }
  }
}

void main() async {
  // Load .env file for local development
  try {
    await dotenv.load(fileName: ".env");
    print('Loaded .env file for local development');
  } catch (e) {
    print('No .env file found (this is OK for production): $e');
  }

  // Initialize Telegram WebApp using flutter_telegram_miniapp package
  // This MUST be called BEFORE runApp() and BEFORE using any WebApp methods
  // It initializes the EventHandler which sets up all event listeners including backButtonClicked
  try {
    tma.WebApp().init();
    print('Telegram WebApp initialized via flutter_telegram_miniapp');
  } catch (e) {
    print('Error initializing Telegram WebApp: $e');
    // Fallback to old initialization if package fails
    final telegramWebApp = TelegramWebApp();
    await telegramWebApp.initialize();
  }
  
  // Initialize theme from Telegram WebApp (will be called again in MyAppState, but this ensures early initialization)
  AppTheme.initialize();

  runApp(const MyApp());
}

// No animation page transition builder
class NoAnimationPageTransitionsBuilder extends PageTransitionsBuilder {
  const NoAnimationPageTransitionsBuilder();

  @override
  Widget buildTransitions<T>(
    PageRoute<T> route,
    BuildContext context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
    Widget child,
  ) {
    return child;
  }
}

class MyApp extends StatefulWidget {
  const MyApp({super.key});

  @override
  State<MyApp> createState() => _MyAppState();
}

class _MyAppState extends State<MyApp> {
  @override
  void initState() {
    super.initState();
    // Initialize theme from Telegram WebApp
    AppTheme.initialize();
    
    // Initialize Vercel Analytics after first frame
    WidgetsBinding.instance.addPostFrameCallback((_) {
      VercelAnalytics.init();
      // Track initial page view
      VercelAnalytics.trackPageView(path: '/', title: 'Home');
      
      // WebApp is already initialized in main() via tma.WebApp().init()
    });
  }
  
  @override
  void dispose() {
    // Clean up listener if needed
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // Listen to theme changes and rebuild when theme changes
    return ValueListenableBuilder<String?>(
      valueListenable: AppTheme.colorSchemeNotifier,
      builder: (context, colorScheme, child) {
        return MaterialApp(
          title: "Hype N' Links",
          builder: (context, child) {
            return SizedBox.expand(
              child: Container(
                color: AppTheme.backgroundColor,
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    if (child != null) child,
                    const GlobalLogoBar(),
                    const GlobalBottomBar(),
                  ],
                ),
              ),
            );
          },
          // Use default theme without Material fonts to avoid loading errors
          theme: ThemeData(
            useMaterial3: false,
            scaffoldBackgroundColor: AppTheme.backgroundColor,
            pageTransitionsTheme: const PageTransitionsTheme(
              builders: {
                TargetPlatform.android: NoAnimationPageTransitionsBuilder(),
                TargetPlatform.iOS: NoAnimationPageTransitionsBuilder(),
                TargetPlatform.macOS: NoAnimationPageTransitionsBuilder(),
                TargetPlatform.windows: NoAnimationPageTransitionsBuilder(),
                TargetPlatform.linux: NoAnimationPageTransitionsBuilder(),
                TargetPlatform.fuchsia: NoAnimationPageTransitionsBuilder(),
              },
            ),
            fontFamily: 'Aeroport',
            textTheme: TextTheme(
              bodyLarge: TextStyle(
                  fontFamily: 'Aeroport',
                  fontSize: 15,
                  fontWeight: FontWeight.w500,
                  color: AppTheme.textColor),
              bodyMedium: TextStyle(
                  fontFamily: 'Aeroport',
                  fontSize: 15,
                  fontWeight: FontWeight.w500,
                  color: AppTheme.textColor),
              bodySmall: TextStyle(
                  fontFamily: 'Aeroport',
                  fontSize: 15,
                  fontWeight: FontWeight.w500,
                  color: AppTheme.textColor),
              displayLarge: TextStyle(
                  fontFamily: 'Aeroport',
                  fontSize: 15,
                  fontWeight: FontWeight.w500,
                  color: AppTheme.textColor),
              displayMedium: TextStyle(
                  fontFamily: 'Aeroport',
                  fontSize: 15,
                  fontWeight: FontWeight.w500,
                  color: AppTheme.textColor),
              displaySmall: TextStyle(
                  fontFamily: 'Aeroport',
                  fontSize: 15,
                  fontWeight: FontWeight.w500,
                  color: AppTheme.textColor),
              headlineLarge: TextStyle(
                  fontFamily: 'Aeroport',
                  fontSize: 15,
                  fontWeight: FontWeight.w500,
                  color: AppTheme.textColor),
              headlineMedium: TextStyle(
                  fontFamily: 'Aeroport',
                  fontSize: 15,
                  fontWeight: FontWeight.w500,
                  color: AppTheme.textColor),
              headlineSmall: TextStyle(
                  fontFamily: 'Aeroport',
                  fontSize: 15,
                  fontWeight: FontWeight.w500,
                  color: AppTheme.textColor),
              titleLarge: TextStyle(
                  fontFamily: 'Aeroport',
                  fontSize: 15,
                  fontWeight: FontWeight.w500,
                  color: AppTheme.textColor),
              titleMedium: TextStyle(
                  fontFamily: 'Aeroport',
                  fontSize: 15,
                  fontWeight: FontWeight.w500,
                  color: AppTheme.textColor),
              titleSmall: TextStyle(
                  fontFamily: 'Aeroport',
                  fontSize: 15,
                  fontWeight: FontWeight.w500,
                  color: AppTheme.textColor),
              labelLarge: TextStyle(
                  fontFamily: 'Aeroport',
                  fontSize: 15,
                  fontWeight: FontWeight.w500,
                  color: AppTheme.textColor),
              labelMedium: TextStyle(
                  fontFamily: 'Aeroport',
                  fontSize: 15,
                  fontWeight: FontWeight.w500,
                  color: AppTheme.textColor),
              labelSmall: TextStyle(
                  fontFamily: 'Aeroport',
              fontSize: 15,
              fontWeight: FontWeight.w500,
              color: AppTheme.textColor),
        ),
        inputDecorationTheme: InputDecorationTheme(
          labelStyle: TextStyle(
              fontFamily: 'Aeroport',
              fontSize: 15,
              fontWeight: FontWeight.w500,
              color: AppTheme.textColor),
          hintStyle: TextStyle(
              fontFamily: 'Aeroport',
              fontSize: 15,
              fontWeight: FontWeight.w500,
              color: AppTheme.textColor),
        ),
      ),
      debugShowCheckedModeBanner: false,
      home: const SimpleMainPage(),
        );
      },
    );
  }
}

// Global logo bar widget that appears on all pages
class GlobalLogoBar extends StatefulWidget {
  const GlobalLogoBar({super.key});

  @override
  State<GlobalLogoBar> createState() => _GlobalLogoBarState();

  // Notifier for fullscreen status changes (to trigger content rebuilds)
  static final ValueNotifier<bool> _fullscreenNotifier = ValueNotifier<bool>(true);
  static ValueNotifier<bool> get fullscreenNotifier => _fullscreenNotifier;

  // Helper method to calculate logo top padding
  static double _getLogoTopPadding() {
    final service = TelegramSafeAreaService();
    
    // Check if we're in a browser (Telegram WebApp not available)
    // In browser, safe area insets are not available, so use fallback
    if (!service.isAvailable) {
      // Browser fallback: use 30px top padding
      return 30.0;
    }
    
    final safeAreaInset = service.getSafeAreaInset();
    final contentSafeAreaInset = service.getContentSafeAreaInset();

    // If both insets are zero (browser or no safe area data), use fallback
    if (safeAreaInset.isEmpty && contentSafeAreaInset.isEmpty) {
      // Browser fallback: use 30px top padding
      return 30.0;
    }

    // Formula: top SafeAreaInset + (top ContentSafeAreaInset / 2) - 16
    // This centers the 32px logo in the content safe area zone, respecting the upper inset
    final topPadding = safeAreaInset.top + (contentSafeAreaInset.top / 2) - 16;
    return topPadding;
  }

  // Helper method to calculate logo block height
  // Logo block consists of: top padding + logo (32px) + bottom padding (10px)
  static double getLogoBlockHeight() {
    const logoHeight = 32.0;
    const bottomPadding = 10.0;
    
    return _getLogoTopPadding() + logoHeight + bottomPadding;
  }

  /// Get the top padding for content based on logo visibility
  /// Returns 10px when logo is hidden, otherwise logo block height + 10px
  /// Uses the fullscreenNotifier to get current logo visibility state
  static double getContentTopPadding() {
    // Check if we're in browser or TMA
    final telegramWebApp = TelegramWebApp();
    final isInBrowser = !telegramWebApp.isActuallyInTelegram;
    
    // Debug logging
    print('[GlobalLogoBar] getContentTopPadding - isAvailable: ${telegramWebApp.isAvailable}, isActuallyInTelegram: ${telegramWebApp.isActuallyInTelegram}, platform: ${telegramWebApp.platform}, initData: ${telegramWebApp.initData}');
    
    // In browser mode, logo is always visible, so content needs full padding
    if (isInBrowser) {
      final logoBlockHeight = getLogoBlockHeight();
      final padding = logoBlockHeight + 10.0;
      print('[GlobalLogoBar] Browser mode - content top padding: $padding (logoBlockHeight: $logoBlockHeight)');
      return padding;
    }
    
    // In TMA mode, check if logo is visible (fullscreen mode)
    // If logo is hidden (not fullscreen), return minimal padding
    final isFullscreen = _fullscreenNotifier.value;
    if (!isFullscreen) {
      print('[GlobalLogoBar] TMA not fullscreen - content top padding: 10.0');
      return 10.0;
    }
    
    // Logo is visible in TMA fullscreen mode, so content needs full padding
    final logoBlockHeight = getLogoBlockHeight();
    final padding = logoBlockHeight + 10.0;
    print('[GlobalLogoBar] TMA fullscreen - content top padding: $padding (logoBlockHeight: $logoBlockHeight)');
    return padding;
  }

  /// Check if logo should be visible
  /// Logo is hidden when: in Telegram AND not in fullscreen
  /// In browser (not Telegram): always show logo
  static bool shouldShowLogo() {
    final telegramWebApp = TelegramWebApp();
    
    // If not in Telegram (browser), always show logo
    if (!telegramWebApp.isActuallyInTelegram) {
      return true; // Always show in browser
    }
    
    // We're in Telegram - check isFullscreen
    final isFullscreen = telegramWebApp.isFullscreen;
    
    // If isFullscreen is null or true, show logo (safe fallback to show)
    // Only hide logo when explicitly not fullscreen (isFullscreen == false)
    return isFullscreen ?? true;
  }
}

class _GlobalLogoBarState extends State<GlobalLogoBar> with SingleTickerProviderStateMixin {
  Timer? _checkTimer;
  late AnimationController _animationController;
  late Animation<double> _scaleAnimation;

  @override
  void initState() {
    super.initState();
    // Initialize animation controller for zoom out effect
    _animationController = AnimationController(
      duration: const Duration(milliseconds: 300),
      vsync: this,
    );
    
    _scaleAnimation = Tween<double>(
      begin: 1.0,
      end: 0.0,
    ).animate(CurvedAnimation(
      parent: _animationController,
      curve: Curves.easeIn,
    ));
    
    // Show logo by default, then check after 1 second
    GlobalLogoBar._fullscreenNotifier.value = true;
    _animationController.value = 1.0; // Start at full scale (visible)
    
    // Check immediately if in browser (don't wait 1 second)
    final telegramWebApp = TelegramWebApp();
    if (!telegramWebApp.isActuallyInTelegram) {
      // In browser, ensure logo is visible and notifier is set immediately
      GlobalLogoBar._fullscreenNotifier.value = true;
    } else {
      // In TMA, check fullscreen status immediately
      final isFullscreen = telegramWebApp.isFullscreen;
      final shouldShow = isFullscreen ?? true;
      GlobalLogoBar._fullscreenNotifier.value = shouldShow;
      
      // Also check after 1 second (in case fullscreen status changes)
      _checkTimer = Timer(const Duration(seconds: 1), () {
        _updateFullscreenStatus();
      });
    }
    
    _setupViewportListener();
  }

  @override
  void dispose() {
    _checkTimer?.cancel();
    _animationController.dispose();
    super.dispose();
  }

  void _updateFullscreenStatus() {
    final telegramWebApp = TelegramWebApp();
    if (!telegramWebApp.isActuallyInTelegram) {
      GlobalLogoBar._fullscreenNotifier.value = true;
      return;
    }
    
    // Update fullscreen notifier directly based on isFullscreen
    final isFullscreen = telegramWebApp.isFullscreen;
    final shouldShow = isFullscreen ?? true;
    GlobalLogoBar._fullscreenNotifier.value = shouldShow;
    
    if (mounted) {
      setState(() {}); // Force rebuild
    }
  }

  void _setupViewportListener() {
    final telegramWebApp = TelegramWebApp();
    if (telegramWebApp.isActuallyInTelegram) {
      telegramWebApp.onViewportChanged((data) {
        _updateFullscreenStatus();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<String?>(
      valueListenable: AppTheme.colorSchemeNotifier,
      builder: (context, colorScheme, _) {
        // Check if we're in browser or TMA
        final telegramWebApp = TelegramWebApp();
        final isInBrowser = !telegramWebApp.isActuallyInTelegram;
        
        // In browser mode, always show logo without animation
        if (isInBrowser) {
          final logoBlockHeight = GlobalLogoBar.getLogoBlockHeight();
          return Positioned(
            top: 0,
            left: 0,
            right: 0,
            child: SafeArea(
              top: false,
              bottom: false,
              child: Material(
                color: Colors.transparent,
                child: Container(
                  width: double.infinity,
                  height: logoBlockHeight,
                  padding: EdgeInsets.only(
                      top: GlobalLogoBar._getLogoTopPadding(),
                      bottom: 10,
                      left: 15,
                      right: 15),
                  child: Center(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 600),
                      child: SizedBox(
                        width: 32,
                        height: 32,
                        child: SvgPicture.asset(
                          AppTheme.isLightTheme
                              ? 'assets/images/logo_light.svg'
                              : 'assets/images/logo_dark.svg',
                          width: 32,
                          height: 32,
                          key: const ValueKey('global_logo'),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          );
        }
        
        // In TMA mode, check isFullscreen and show/hide logo directly without animation
        // Use ValueListenableBuilder to react to fullscreen changes
        return ValueListenableBuilder<bool>(
          valueListenable: GlobalLogoBar.fullscreenNotifier,
          builder: (context, shouldShowLogo, _) {
            // Hide logo if not fullscreen
            if (!shouldShowLogo) {
              return const SizedBox.shrink();
            }
            
            // Show logo directly in TMA fullscreen mode
            final logoBlockHeight = GlobalLogoBar.getLogoBlockHeight();
            return Positioned(
              top: 0,
              left: 0,
              right: 0,
              child: SafeArea(
                top: false,
                bottom: false,
                child: Material(
                  color: Colors.transparent,
                  child: Container(
                    width: double.infinity,
                    height: logoBlockHeight,
                    padding: EdgeInsets.only(
                        top: GlobalLogoBar._getLogoTopPadding(),
                        bottom: 10,
                        left: 15,
                        right: 15),
                    child: Center(
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 600),
                        child: SizedBox(
                          width: 32,
                          height: 32,
                          child: SvgPicture.asset(
                            AppTheme.isLightTheme
                                ? 'assets/images/logo_light.svg'
                                : 'assets/images/logo_dark.svg',
                            width: 32,
                            height: 32,
                            key: const ValueKey('global_logo'),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            );
          },
        );
      },
    );
  }
}

// Global bottom bar widget that appears on all pages
class GlobalBottomBar extends StatefulWidget {
  const GlobalBottomBar({super.key});

  @override
  State<GlobalBottomBar> createState() => _GlobalBottomBarState();
}

class _GlobalBottomBarState extends State<GlobalBottomBar> {
  final TextEditingController _controller = TextEditingController();
  final FocusNode _focusNode = FocusNode();
  final GlobalKey _textFieldKey = GlobalKey();
  bool _isFocused = false;

  @override
  void initState() {
    super.initState();
    _focusNode.addListener(() {
      setState(() {
        _isFocused = _focusNode.hasFocus;
      });
    });
    _controller.addListener(() {
      if (_controller.text.contains('\n')) {
        final textWithoutNewline = _controller.text.replaceAll('\n', '');
        _controller.value = TextEditingValue(
          text: textWithoutNewline,
          selection: TextSelection.collapsed(offset: textWithoutNewline.length),
        );
      }
      setState(() {});
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  void _navigateToNewPage() {
    final text = _controller.text.trim();
    if (text.isNotEmpty) {
      VercelAnalytics.trackEvent('question_submitted', properties: {
        'question_length': text.length.toString(),
      });

      VercelAnalytics.trackPageView(path: '/response', title: 'Response');

      Navigator.push(
        context,
        PageRouteBuilder(
          pageBuilder: (context, animation, secondaryAnimation) => NewPage(title: text),
          transitionDuration: Duration.zero,
          reverseTransitionDuration: Duration.zero,
        ),
      ).then((_) {
        _controller.clear();
        VercelAnalytics.trackPageView(path: '/', title: 'Home');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Positioned(
      bottom: 0,
      left: 0,
      right: 0,
      child: Material(
        color: AppTheme.backgroundColor,
        child: Container(
          width: double.infinity,
          padding: const EdgeInsets.only(top: 10, bottom: 15),
          child: SafeArea(
            top: false,
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 600),
                child: Padding(
                  padding: const EdgeInsets.only(left: 15, right: 15),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                Expanded(
                  child: Container(
                    constraints: const BoxConstraints(minHeight: 30),
                    child: _controller.text.isEmpty
                      ? SizedBox(
                          height: 30,
                          child: TextField(
                            key: _textFieldKey,
                            controller: _controller,
                            focusNode: _focusNode,
                            enabled: true,
                            readOnly: false,
                            cursorColor: AppTheme.textColor,
                            cursorHeight: 15,
                            maxLines: 11,
                            minLines: 1,
                            textAlignVertical: TextAlignVertical.center,
                            style: TextStyle(
                                fontFamily: 'Aeroport',
                                fontSize: 15,
                                fontWeight: FontWeight.w500,
                                height: 2.0,
                                color: AppTheme.textColor),
                            onSubmitted: (value) {
                              _navigateToNewPage();
                            },
                            onChanged: (value) {},
                            decoration: InputDecoration(
                              hintText: (_isFocused ||
                                      _controller.text.isNotEmpty)
                                  ? null
                                  : 'AI AND SEARCH',
                              hintStyle: TextStyle(
                                  color: AppTheme.textColor,
                                  fontFamily: 'Aeroport',
                                  fontSize: 15,
                                  fontWeight: FontWeight.w500,
                                  height: 2.0),
                              border: InputBorder.none,
                              enabledBorder: InputBorder.none,
                              focusedBorder: InputBorder.none,
                              isDense: true,
                              contentPadding: !_isFocused
                                  ? const EdgeInsets.only(
                                      left: 0,
                                      right: 0,
                                      top: 5,
                                      bottom: 5)
                                  : const EdgeInsets.only(right: 0),
                            ),
                          ),
                        )
                      : Padding(
                          padding: const EdgeInsets.only(bottom: 8),
                          child: TextField(
                            key: _textFieldKey,
                            controller: _controller,
                            focusNode: _focusNode,
                            enabled: true,
                            readOnly: false,
                            cursorColor: AppTheme.textColor,
                            cursorHeight: 15,
                            maxLines: 11,
                            minLines: 1,
                            textAlignVertical: _controller.text
                                        .split('\n')
                                        .length ==
                                    1
                                ? TextAlignVertical.center
                                : TextAlignVertical.bottom,
                            style: TextStyle(
                                fontFamily: 'Aeroport',
                                fontSize: 15,
                                fontWeight: FontWeight.w500,
                                height: 2,
                                color: AppTheme.textColor),
                            onSubmitted: (value) {
                              _navigateToNewPage();
                            },
                            onChanged: (value) {},
                            decoration: InputDecoration(
                              hintText: (_isFocused ||
                                      _controller.text.isNotEmpty)
                                  ? null
                                  : 'AI AND SEARCH',
                              hintStyle: TextStyle(
                                  color: AppTheme.textColor,
                                  fontFamily: 'Aeroport',
                                  fontSize: 15,
                                  fontWeight: FontWeight.w500,
                                  height: 2),
                              border: InputBorder.none,
                              enabledBorder: InputBorder.none,
                              focusedBorder: InputBorder.none,
                              isDense: true,
                              contentPadding: _controller.text
                                          .split('\n')
                                          .length >
                                      1
                                  ? const EdgeInsets.only(
                                      left: 0, right: 0, top: 11)
                                  : const EdgeInsets.only(right: 0),
                            ),
                          ),
                        ),
                ),
              ),
              const SizedBox(width: 5),
              Padding(
                padding: const EdgeInsets.only(bottom: 7.5),
                child: GestureDetector(
                  onTap: () {
                    _navigateToNewPage();
                  },
                  child: SvgPicture.asset(
                    AppTheme.isLightTheme
                        ? 'assets/icons/apply_light.svg'
                        : 'assets/icons/apply_dark.svg',
                    width: 15,
                    height: 10,
                  ),
                ),
              ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class SimpleMainPage extends StatefulWidget {
  const SimpleMainPage({super.key});

  @override
  State<SimpleMainPage> createState() => _SimpleMainPageState();
}

class _SimpleMainPageState extends State<SimpleMainPage>
    with TickerProviderStateMixin {
  // Helper method to calculate adaptive bottom padding
  double _getAdaptiveBottomPadding() {
    final service = TelegramSafeAreaService();
    final safeAreaInset = service.getSafeAreaInset();

    // Formula: bottom SafeAreaInset + 30px
    final bottomPadding = safeAreaInset.bottom + 30;
    return bottomPadding;
  }

  String _selectedTab = 'Feed'; // Default selected tab

  // Mock coin data
  final List<Map<String, dynamic>> _coins = [
    {
      'icon': 'assets/sample/DLLR.svg',
      'ticker': 'DLLR',
      'blockchain': 'TON',
      'amount': '1',
      'usdValue': '\$1',
    },
  ];

  // Feed items data with SVG images
  List<Map<String, dynamic>> get _feedItems {
    
    return [
      {
        'icon': 'assets/sample/mak/1.svg',
        'primaryText': 'CLATH 41 NFT recieved',
        'secondaryText': 'AI CLATH Collection',
        'timestamp': '15:22',
        'rightText': 'Price N/A',
      },
      {
        'icon': 'assets/sample/mak/2.svg',
        'primaryText': 'Token granted',
        'secondaryText': '\$1',
        'timestamp': '13:17',
        'rightText': '+1 DLLR',
      },
      {
        'icon': 'assets/sample/mak/3.svg',
        'primaryText': 'Welcome message',
        'secondaryText': "We've created a wallet for you.",
        'timestamp': '7:55',
        'rightText': null,
      },
    ];
  }

  late final AnimationController _bgController;
  late final Animation<double> _bgAnimation;
  late final double _bgSeed;
  late final AnimationController _noiseController;
  late final Animation<double> _noiseAnimation;

  @override
  void initState() {
    super.initState();

    final random = math.Random();
    final durationMs = 20000 + random.nextInt(14000);
    _bgController = AnimationController(
      vsync: this,
      duration: Duration(milliseconds: durationMs),
    )..repeat(reverse: true);
    _bgAnimation =
        CurvedAnimation(parent: _bgController, curve: Curves.easeInOut);
    _bgSeed = random.nextDouble();
    _noiseController = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 24),
    )..repeat(reverse: true);
    _noiseAnimation =
        Tween<double>(begin: -0.2, end: 0.2).animate(CurvedAnimation(
      parent: _noiseController,
      curve: Curves.easeInOut,
    ));
  }

  @override
  void dispose() {
    _bgController.dispose();
    _noiseController.dispose();
    super.dispose();
  }

  Color _shiftColor(Color base, double shift) {
    final hsl = HSLColor.fromColor(base);
    final newLightness = (hsl.lightness + shift).clamp(0.0, 1.0);
    final newHue = (hsl.hue + shift * 10) % 360;
    final newSaturation = (hsl.saturation + shift * 0.1).clamp(0.0, 1.0);
    return hsl
        .withLightness(newLightness)
        .withHue(newHue)
        .withSaturation(newSaturation)
        .toColor();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: AnimatedBuilder(
        animation: _bgAnimation,
        builder: (context, child) {
          final baseShimmer =
              math.sin(2 * math.pi * (_bgAnimation.value + _bgSeed));
          final shimmer = 0.007 * baseShimmer;
          final baseColors = AppTheme.baseColors;
          const stopsCount = 28;
          final colors = List.generate(stopsCount, (index) {
            final progress = index / (stopsCount - 1);
            final scaled = progress * (baseColors.length - 1);
            final lowerIndex = scaled.floor();
            final upperIndex = scaled.ceil();
            final frac = scaled - lowerIndex;
            final lower =
                baseColors[lowerIndex.clamp(0, baseColors.length - 1)];
            final upper =
                baseColors[upperIndex.clamp(0, baseColors.length - 1)];
            final blended = Color.lerp(lower, upper, frac)!;
            final offset = index * 0.0015;
            return _shiftColor(blended, shimmer * (0.035 + offset));
          });
          final stops = List.generate(
              colors.length, (index) => index / (colors.length - 1));
          final rotation =
              math.sin(2 * math.pi * (_bgAnimation.value + _bgSeed)) * 0.35;
          final begin = Alignment(-0.8 + rotation, -0.7 - rotation * 0.2);
          final end = Alignment(0.9 - rotation, 0.8 + rotation * 0.2);
          return Stack(
            fit: StackFit.expand,
            children: [
              Container(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: begin,
                    end: end,
                    colors: colors,
                    stops: stops,
                  ),
                ),
              ),
              AnimatedBuilder(
                animation: _noiseAnimation,
                builder: (context, _) {
                  final alignment = Alignment(
                    0.2 + _noiseAnimation.value,
                    -0.4 + _noiseAnimation.value * 0.5,
                  );
                  return Container(
                    decoration: BoxDecoration(
                      gradient: RadialGradient(
                        center: alignment,
                        radius: 0.75,
                        colors: [
                          Colors.white.withOpacity(0.01),
                          Colors.transparent,
                        ],
                        stops: const [0.0, 1.0],
                      ),
                    ),
                  );
                },
              ),
              Container(
                decoration: BoxDecoration(
                  gradient: RadialGradient(
                    center: const Alignment(0.7, -0.6),
                    radius: 0.8,
                    colors: [
                      _shiftColor(AppTheme.radialGradientColor, shimmer * 0.4),
                      Colors.transparent,
                    ],
                    stops: const [0.0, 1.0],
                  ),
                  color: AppTheme.overlayColor.withOpacity(0.02),
                ),
              ),
              IgnorePointer(
                child: Container(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      colors: [
                        Colors.white.withOpacity(0.01),
                        Colors.transparent,
                        Colors.white.withOpacity(0.005),
                      ],
                      stops: const [0.0, 0.5, 1.0],
                    ),
                  ),
                ),
              ),
              child!,
            ],
          );
        },
        child: SafeArea(
          bottom: false,
          top: false, // Disable SafeArea top padding - we handle it manually
          child: ValueListenableBuilder<bool>(
            valueListenable: GlobalLogoBar.fullscreenNotifier,
            builder: (context, isFullscreen, child) {
              final topPadding = GlobalLogoBar.getContentTopPadding();
              print('[SimpleMainPage] Applying content top padding: $topPadding');
              return Padding(
                padding: EdgeInsets.only(
                    bottom: _getAdaptiveBottomPadding(),
                    top: topPadding, // Dynamic padding based on logo visibility
                    left: 15,
                    right: 15),
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 600),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.center,
                  mainAxisAlignment: MainAxisAlignment.start,
                  children: [
                    // Hash row with icons - content part
                    Padding(
                      padding: const EdgeInsets.only(bottom: 15),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        crossAxisAlignment: CrossAxisAlignment.center,
                        children: [
                          const Text(
                            '..xk5str4e',
                            style: TextStyle(
                              fontFamily: 'Aeroport Mono',
                              fontSize: 15,
                              fontWeight: FontWeight.w400,
                              color: Color(0xFF818181),
                            ),
                          ),
                          Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              GestureDetector(
                                onTap: () {
                                  // Copy action
                                },
                                child: SvgPicture.asset(
                                  'assets/icons/copy.svg',
                                  width: 30,
                                  height: 30,
                                ),
                              ),
                              const SizedBox(width: 15),
                              GestureDetector(
                                onTap: () {
                                  // Edit action
                                },
                                child: SvgPicture.asset(
                                  'assets/icons/edit.svg',
                                  width: 30,
                                  height: 30,
                                ),
                              ),
                              const SizedBox(width: 15),
                              GestureDetector(
                                onTap: () {
                                  // Edit action
                                },
                                child: SvgPicture.asset(
                                  'assets/icons/key.svg',
                                  width: 30,
                                  height: 30,
                                ),
                              ),
                              const SizedBox(width: 15),
                              GestureDetector(
                                onTap: () {
                                  // Exit action
                                },
                                child: SvgPicture.asset(
                                  'assets/icons/exit.svg',
                                  width: 30,
                                  height: 30,
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                          Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            crossAxisAlignment: CrossAxisAlignment.center,
                            textBaseline: TextBaseline.alphabetic,
                            children: [
                              Text(
                                r'$1',
                                style: TextStyle(
                                  fontFamily: 'Aeroport',
                                  fontSize: 30,
                                  fontWeight: FontWeight.w400,
                                  color: AppTheme.textColor,
                                  height: 1.0,
                                ),
                                textHeightBehavior: const TextHeightBehavior(
                                  applyHeightToFirstAscent: false,
                                  applyHeightToLastDescent: false,
                                ),
                              ),
                              Row(
                                mainAxisSize: MainAxisSize.min,
                                crossAxisAlignment: CrossAxisAlignment.center,
                                children: [
                                  const Text(
                                    'Sendal Rodriges',
                                    style: TextStyle(
                                      fontFamily: 'Aeroport',
                                      fontSize: 15,
                                      fontWeight: FontWeight.w400,
                                      color: Color(0xFF818181),
                                      height: 1.0,
                                    ),
                                    textHeightBehavior:
                                        const TextHeightBehavior(
                                      applyHeightToFirstAscent: false,
                                      applyHeightToLastDescent: false,
                                    ),
                                  ),
                                  const SizedBox(width: 5),
                                  SvgPicture.asset('assets/icons/select.svg', width: 5, height: 10),
                                ],
                              ),
                            ],
                          ),
                          const SizedBox(height: 30),
                          Row(
                            children: [
                              Expanded(
                                child: Column(
                                  mainAxisSize: MainAxisSize.min,
                                  crossAxisAlignment: CrossAxisAlignment.center,
                                  children: [
                                    SvgPicture.asset(
                                      AppTheme.isLightTheme
                                          ? 'assets/icons/menudva/get_light.svg'
                                          : 'assets/icons/menudva/get_dark.svg',
                                      width: 30,
                                      height: 30,
                                    ),
                                    const SizedBox(height: 5),
                                    SizedBox(
                                      height: 15,
                                      child: Center(
                                        child: Text(
                                          'Get',
                                          style: TextStyle(
                                            fontFamily: 'Aeroport',
                                            fontSize: 15,
                                            fontWeight: FontWeight.w500,
                                            color: AppTheme.textColor,
                                            height: 1.0,
                                          ),
                                          textHeightBehavior:
                                              const TextHeightBehavior(
                                            applyHeightToFirstAscent: false,
                                            applyHeightToLastDescent: false,
                                          ),
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                              Expanded(
                                child: GestureDetector(
                                  onTap: () {
                                    Navigator.push(
                                      context,
                                      PageRouteBuilder(
                                        pageBuilder: (context, animation, secondaryAnimation) => const HomePage(),
                                        transitionDuration: Duration.zero,
                                        reverseTransitionDuration: Duration.zero,
                                      ),
                                    );
                                  },
                                  child: Column(
                                    mainAxisSize: MainAxisSize.min,
                                    crossAxisAlignment:
                                        CrossAxisAlignment.center,
                                    children: [
                                      SvgPicture.asset(
                                        AppTheme.isLightTheme
                                            ? 'assets/icons/menudva/swap_light.svg'
                                            : 'assets/icons/menudva/swap_dark.svg',
                                        width: 30,
                                        height: 30,
                                      ),
                                      const SizedBox(height: 5),
                                      SizedBox(
                                        height: 15,
                                        child: Center(
                                          child: Text(
                                            'Swap',
                                            style: TextStyle(
                                              fontFamily: 'Aeroport',
                                              fontSize: 15,
                                              fontWeight: FontWeight.w500,
                                              color: AppTheme.textColor,
                                              height: 1.0,
                                            ),
                                            textHeightBehavior:
                                                const TextHeightBehavior(
                                              applyHeightToFirstAscent: false,
                                              applyHeightToLastDescent: false,
                                            ),
                                          ),
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                              Expanded(
                                child: GestureDetector(
                                  onTap: () {
                                    Navigator.push(
                                      context,
                                      PageRouteBuilder(
                                        pageBuilder: (context, animation, secondaryAnimation) => const TradePage(),
                                        transitionDuration: Duration.zero,
                                        reverseTransitionDuration: Duration.zero,
                                      ),
                                    );
                                  },
                                  child: Column(
                                    mainAxisSize: MainAxisSize.min,
                                    crossAxisAlignment:
                                        CrossAxisAlignment.center,
                                    children: [
                                      SvgPicture.asset(
                                        AppTheme.isLightTheme
                                            ? 'assets/icons/menudva/trade_light.svg'
                                            : 'assets/icons/menudva/trade_dark.svg',
                                        width: 30,
                                        height: 30,
                                      ),
                                      const SizedBox(height: 5),
                                      SizedBox(
                                        height: 15,
                                        child: Center(
                                          child: Text(
                                            'Trade',
                                            style: TextStyle(
                                              fontFamily: 'Aeroport',
                                              fontSize: 15,
                                              fontWeight: FontWeight.w500,
                                              color: AppTheme.textColor,
                                              height: 1.0,
                                            ),
                                            textHeightBehavior:
                                                const TextHeightBehavior(
                                              applyHeightToFirstAscent: false,
                                              applyHeightToLastDescent: false,
                                            ),
                                          ),
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                              Expanded(
                                child: Column(
                                  mainAxisSize: MainAxisSize.min,
                                  crossAxisAlignment: CrossAxisAlignment.center,
                                  children: [
                                    SvgPicture.asset(
                                      AppTheme.isLightTheme
                                          ? 'assets/icons/menudva/send_light.svg'
                                          : 'assets/icons/menudva/send_dark.svg',
                                      width: 30,
                                      height: 30,
                                    ),
                                    const SizedBox(height: 5),
                                    SizedBox(
                                      height: 15,
                                      child: Center(
                                        child: Text(
                                          'Send',
                                          style: TextStyle(
                                            fontFamily: 'Aeroport',
                                            fontSize: 15,
                                            fontWeight: FontWeight.w500,
                                            color: AppTheme.textColor,
                                            height: 1.0,
                                          ),
                                          textHeightBehavior:
                                              const TextHeightBehavior(
                                            applyHeightToFirstAscent: false,
                                            applyHeightToLastDescent: false,
                                          ),
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 30),
                          Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              GestureDetector(
                                onTap: () {
                                  setState(() {
                                    _selectedTab = 'Feed';
                                  });
                                },
                                child: Text(
                                  'Feed',
                                  style: TextStyle(
                                    fontFamily: 'Aeroport',
                                    fontSize: 20,
                                    fontWeight: FontWeight.w500,
                                    color: _selectedTab == 'Feed'
                                        ? AppTheme.textColor
                                        : const Color(0xFF818181),
                                  ),
                                ),
                              ),
                              const SizedBox(width: 15),
                              GestureDetector(
                                onTap: () {
                                  setState(() {
                                    _selectedTab = 'Coins';
                                  });
                                },
                                child: Text(
                                  'Coins',
                                  style: TextStyle(
                                    fontFamily: 'Aeroport',
                                    fontSize: 20,
                                    fontWeight: FontWeight.w500,
                                    color: _selectedTab == 'Coins'
                                        ? AppTheme.textColor
                                        : const Color(0xFF818181),
                                  ),
                                ),
                              ),
                              const SizedBox(width: 15),
                              GestureDetector(
                                onTap: () {
                                  setState(() {
                                    _selectedTab = 'Items';
                                  });
                                },
                                child: Text(
                                  'Items',
                                  style: TextStyle(
                                    fontFamily: 'Aeroport',
                                    fontSize: 20,
                                    fontWeight: FontWeight.w500,
                                    color: _selectedTab == 'Items'
                                        ? AppTheme.textColor
                                        : const Color(0xFF818181),
                                  ),
                                ),
                              ),
                              const SizedBox(width: 15),
                              GestureDetector(
                                onTap: () {
                                  setState(() {
                                    _selectedTab = 'Chat';
                                  });
                                },
                                child: Text(
                                  'Chat',
                                  style: TextStyle(
                                    fontFamily: 'Aeroport',
                                    fontSize: 20,
                                    fontWeight: FontWeight.w500,
                                    color: _selectedTab == 'Chat'
                                        ? AppTheme.textColor
                                        : const Color(0xFF818181),
                                  ),
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 20),
                          // Feed list - shown when Feed tab is selected
                          if (_selectedTab == 'Feed')
                            Column(
                              children: _feedItems.map((item) {
                                return Padding(
                                  padding: const EdgeInsets.only(bottom: 20),
                                  child: Container(
                                    padding:
                                        const EdgeInsets.symmetric(vertical: 0),
                                    child: Row(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.center,
                                      children: [
                                        // Feed item icon - 30px, centered vertically relative to 40px text columns
                                        SvgPicture.asset(
                                          item['icon'] as String,
                                          width: 30,
                                          height: 30,
                                          fit: BoxFit.contain,
                                        ),
                                        const SizedBox(width: 10),
                                        // Primary and secondary text column
                                        Expanded(
                                          child: Column(
                                            crossAxisAlignment:
                                                CrossAxisAlignment.start,
                                            children: [
                                              SizedBox(
                                                height: 20,
                                                child: Align(
                                                  alignment:
                                                      Alignment.centerLeft,
                                                  child: Text(
                                                    item['primaryText'] as String,
                                                    style: TextStyle(
                                                      fontFamily: 'Aeroport',
                                                      fontSize: 15,
                                                      fontWeight:
                                                          FontWeight.w500,
                                                      color: AppTheme.textColor,
                                                      height: 1.0,
                                                    ),
                                                    textHeightBehavior:
                                                        const TextHeightBehavior(
                                                      applyHeightToFirstAscent:
                                                          false,
                                                      applyHeightToLastDescent:
                                                          false,
                                                    ),
                                                  ),
                                                ),
                                              ),
                                              SizedBox(
                                                height: 20,
                                                child: Align(
                                                  alignment:
                                                      Alignment.centerLeft,
                                                  child: Text(
                                                    item['secondaryText'] as String,
                                                    style: const TextStyle(
                                                      fontFamily: 'Aeroport',
                                                      fontSize: 15,
                                                      fontWeight:
                                                          FontWeight.w400,
                                                      color: Color(0xFF818181),
                                                      height: 1.0,
                                                    ),
                                                    textHeightBehavior:
                                                        const TextHeightBehavior(
                                                      applyHeightToFirstAscent:
                                                          false,
                                                      applyHeightToLastDescent:
                                                          false,
                                                    ),
                                                  ),
                                                ),
                                              ),
                                            ],
                                          ),
                                        ),
                                        // Timestamp and right text column (right-aligned)
                                        Column(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.end,
                                          children: [
                                            SizedBox(
                                              height: 20,
                                              child: Align(
                                                alignment:
                                                    Alignment.centerRight,
                                                child: Text(
                                                  item['timestamp'] as String,
                                                  style: TextStyle(
                                                    fontFamily: 'Aeroport',
                                                    fontSize: 15,
                                                    fontWeight: FontWeight.w500, // medium
                                                    color: AppTheme.textColor,
                                                    height: 1.0,
                                                  ),
                                                  textAlign: TextAlign.right,
                                                  textHeightBehavior:
                                                      const TextHeightBehavior(
                                                    applyHeightToFirstAscent:
                                                        false,
                                                    applyHeightToLastDescent:
                                                        false,
                                                  ),
                                                ),
                                              ),
                                            ),
                                            SizedBox(
                                              height: 20,
                                              child: item['rightText'] != null
                                                  ? Align(
                                                      alignment:
                                                          Alignment.centerRight,
                                                      child: Text(
                                                        item['rightText'] as String,
                                                        style: const TextStyle(
                                                          fontFamily: 'Aeroport',
                                                          fontSize: 15,
                                                          fontWeight: FontWeight.w400,
                                                          color: Color(0xFF818181),
                                                          height: 1.0,
                                                        ),
                                                        textAlign: TextAlign.right,
                                                        textHeightBehavior:
                                                            const TextHeightBehavior(
                                                          applyHeightToFirstAscent:
                                                              false,
                                                          applyHeightToLastDescent:
                                                              false,
                                                        ),
                                                      ),
                                                    )
                                                  : const SizedBox.shrink(),
                                            ),
                                          ],
                                        ),
                                      ],
                                    ),
                                  ),
                                );
                              }).toList(),
                            ),
                          // Coins list - shown when Coins tab is selected
                          if (_selectedTab == 'Coins')
                            Column(
                              children: _coins.map((coin) {
                                return Padding(
                                  padding: const EdgeInsets.only(bottom: 20),
                                  child: Container(
                                    padding:
                                        const EdgeInsets.symmetric(vertical: 0),
                                    child: Row(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.center,
                                      children: [
                                        // Coin icon - 30px, centered vertically relative to 40px text columns
                                        (coin['icon'] as String).endsWith('.svg')
                                            ? SvgPicture.asset(
                                                coin['icon'] as String,
                                                width: 30,
                                                height: 30,
                                                fit: BoxFit.contain,
                                              )
                                            : Image.asset(
                                                coin['icon'] as String,
                                                width: 30,
                                                height: 30,
                                                fit: BoxFit.contain,
                                              ),
                                        const SizedBox(width: 10),
                                        // Coin ticker and blockchain column
                                        Expanded(
                                          child: Column(
                                            crossAxisAlignment:
                                                CrossAxisAlignment.start,
                                            children: [
                                              SizedBox(
                                                height: 20,
                                                child: Align(
                                                  alignment:
                                                      Alignment.centerLeft,
                                                  child: Text(
                                                    coin['ticker'] as String,
                                                    style: TextStyle(
                                                      fontFamily: 'Aeroport',
                                                      fontSize: 15,
                                                      fontWeight:
                                                          FontWeight.w500,
                                                      color: AppTheme.textColor,
                                                      height: 1.0,
                                                    ),
                                                    textHeightBehavior:
                                                        const TextHeightBehavior(
                                                      applyHeightToFirstAscent:
                                                          false,
                                                      applyHeightToLastDescent:
                                                          false,
                                                    ),
                                                  ),
                                                ),
                                              ),
                                              SizedBox(
                                                height: 20,
                                                child: Align(
                                                  alignment:
                                                      Alignment.centerLeft,
                                                  child: Text(
                                                    coin['blockchain']
                                                        as String,
                                                    style: const TextStyle(
                                                      fontFamily: 'Aeroport',
                                                      fontSize: 15,
                                                      fontWeight:
                                                          FontWeight.w400,
                                                      color: Color(0xFF818181),
                                                      height: 1.0,
                                                    ),
                                                    textHeightBehavior:
                                                        const TextHeightBehavior(
                                                      applyHeightToFirstAscent:
                                                          false,
                                                      applyHeightToLastDescent:
                                                          false,
                                                    ),
                                                  ),
                                                ),
                                              ),
                                            ],
                                          ),
                                        ),
                                        // Amount and USD value column (right-aligned)
                                        Column(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.end,
                                          children: [
                                            SizedBox(
                                              height: 20,
                                              child: Align(
                                                alignment:
                                                    Alignment.centerRight,
                                                child: Text(
                                                  coin['amount'] as String,
                                                  style: TextStyle(
                                                    fontFamily: 'Aeroport',
                                                    fontSize: 15,
                                                    fontWeight: FontWeight.w500,
                                                    color: AppTheme.textColor,
                                                    height: 1.0,
                                                  ),
                                                  textAlign: TextAlign.right,
                                                  textHeightBehavior:
                                                      const TextHeightBehavior(
                                                    applyHeightToFirstAscent:
                                                        false,
                                                    applyHeightToLastDescent:
                                                        false,
                                                  ),
                                                ),
                                              ),
                                            ),
                                            SizedBox(
                                              height: 20,
                                              child: Align(
                                                alignment:
                                                    Alignment.centerRight,
                                                child: Text(
                                                  coin['usdValue'] as String,
                                                  style: const TextStyle(
                                                    fontFamily: 'Aeroport',
                                                    fontSize: 15,
                                                    fontWeight: FontWeight.w400,
                                                    color: Color(0xFF818181),
                                                    height: 1.0,
                                                  ),
                                                  textAlign: TextAlign.right,
                                                  textHeightBehavior:
                                                      const TextHeightBehavior(
                                                    applyHeightToFirstAscent:
                                                        false,
                                                    applyHeightToLastDescent:
                                                        false,
                                                  ),
                                                ),
                                              ),
                                            ),
                                          ],
                                        ),
                                      ],
                                    ),
                                  ),
                                );
                              }).toList(),
                            ),
                  ],
                ),
              ),
            ),
              );
            },
          ),
        ),
      ),
    );
  }
}

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> with TickerProviderStateMixin {
  // Helper method to calculate adaptive bottom padding
  double _getAdaptiveBottomPadding() {
    final service = TelegramSafeAreaService();
    final safeAreaInset = service.getSafeAreaInset();

    // Formula: bottom SafeAreaInset + 30px
    final bottomPadding = safeAreaInset.bottom + 30;
    return bottomPadding;
  }

  // Helper method to calculate GlobalBottomBar height
  // GlobalBottomBar structure:
  // - Container padding: top: 10, bottom: 15 (total 25px)
  // - TextField minHeight: 30px
  double _getGlobalBottomBarHeight() {
    // Minimum height: container padding (10 + 15) + TextField minHeight (30)
    return 10.0 + 30.0 + 15.0;
  }
  
  void _handleBackButton() {
    Navigator.of(context).pop();
  }
  
  StreamSubscription<tma.BackButton>? _backButtonSubscription;

  // Chart data
  List<double>? _chartDataPoints;
  bool _isLoadingChart = true;
  String? _chartError; // Error message for chart loading
  String _selectedResolution = 'day1'; // Default: day1 (d)
  double? _chartMinPrice;
  double? _chartMaxPrice;
  DateTime? _chartFirstTimestamp;
  DateTime? _chartLastTimestamp;

  // Original chart data for point selection (prices and timestamps)
  List<Map<String, dynamic>>? _originalChartData;

  // Selected point for interactive chart
  int? _selectedPointIndex;

  // Rate limiting for dyor API (1 call per second)
  DateTime? _lastChartApiCall;
  int _chartRetryCount = 0;
  static const int _maxRetries = 5;
  static const Duration _rateLimitDelay = Duration(seconds: 1);

  // TON address for default pair
  static const String _tonAddress =
      '0:0000000000000000000000000000000000000000000000000000000000000000';
  static const String _chartApiUrl = 'https://api.dyor.io';
  static const String _swapCoffeeApiUrl = 'https://backend.swap.coffee';
  // USDT contract address on TON blockchain
  static const String _usdtAddress =
      'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';

  // Swap state variables
  final String _buyCurrency = 'TON';
  final double _buyAmount = 1.0; // Default: 1 TON
  final String _sellCurrency = 'USDT';
  double? _sellAmount; // Will be fetched from API
  bool _isLoadingSwapAmount = false;
  String? _usdtTokenAddress; // Will be fetched from API if needed
  String? _swapAmountError; // Error message if fetch fails

  // Market stats state variables
  static const String _tokensApiUrl = 'https://tokens.swap.coffee';
  double? _priceUsd; // Current price in USD
  double? _mcap;
  double? _fdmc;
  double? _volume24h;
  double? _priceChange5m;
  double? _priceChange1h;
  double? _priceChange6h;
  double? _priceChange24h;
  late final AnimationController _bgController;
  late final Animation<double> _bgAnimation;
  late final double _bgSeed;
  late final AnimationController _noiseController;
  late final Animation<double> _noiseAnimation;

  // Resolution mapping: button -> API value
  static const Map<String, String> _resolutionMap = {
    'd': 'day1',
    'h': 'hour1',
    'q': 'min15',
    'm': 'min1',
  };

  // Maximum time ranges for each resolution (in days)
  static const Map<String, int> _maxTimeRanges = {
    'day1': 365, // 365 days
    'hour1': 30, // 30 days
    'min15': 7, // 7 days
    'min1': 1, // 24 hours = 1 day
  };

  /// Calculate the time range for the selected resolution
  /// Returns a map with 'from' and 'to' as ISO 8601 strings
  Map<String, String> _getTimeRange() {
    final now = DateTime.now().toUtc();
    final maxDays = _maxTimeRanges[_selectedResolution] ?? 30;

    // Calculate 'from' date: maxDays ago
    final from = now.subtract(Duration(days: maxDays));

    return {
      'from': from.toIso8601String(),
      'to': now.toIso8601String(),
    };
  }

  /// Handle chart pointer to find closest point using hybrid method:
  /// - If pointer is close to chart: use Euclidean distance (x and y) for precise selection
  /// - If pointer is far from chart: use x-axis only for quick selection
  void _handleChartPointer(Offset localPosition, Size chartSize) {
    if (_chartDataPoints == null ||
        _chartDataPoints!.isEmpty ||
        _originalChartData == null) {
      return;
    }

    final pointCount = _chartDataPoints!.length;
    if (pointCount == 0) return;

    // Validate chart size
    if (chartSize.width <= 0 || chartSize.height <= 0) {
      return;
    }

    // Calculate step size (same as in painter)
    final stepSize = pointCount > 1 ? chartSize.width / (pointCount - 1) : 0.0;

    // First, find the closest point by x-axis to determine proximity
    int closestByX = 0;
    double minXDistance = double.infinity;

    for (int i = 0; i < pointCount; i++) {
      final pointX = i * stepSize;
      final xDistance = (localPosition.dx - pointX).abs();
      if (xDistance < minXDistance) {
        minXDistance = xDistance;
        closestByX = i;
      }
    }

    // Calculate the y position of the closest x point to check vertical distance
    final normalizedValue = _chartDataPoints![closestByX];
    final closestPointY =
        chartSize.height - (normalizedValue * chartSize.height);
    final verticalDistance = (localPosition.dy - closestPointY).abs();

    // Threshold: use a combination of fixed pixels and percentage of chart height
    // This ensures reasonable proximity detection for both small and large charts
    // - Minimum: 40 pixels (ensures reasonable proximity even for small charts)
    // - Maximum: 15% of chart height (scales with chart size for larger charts)
    // Result: uses whichever is larger, so small charts get at least 40px, large charts scale up
    // This means: if pointer is within ~40-60px of the chart line, use precise Euclidean selection
    const fixedThreshold = 40.0; // pixels - minimum threshold
    final percentageThreshold = chartSize.height * 0.15; // 15% of chart height
    final proximityThreshold = math.max(fixedThreshold, percentageThreshold);
    final isCloseToChart = verticalDistance < proximityThreshold;

    int closestIndex;
    if (isCloseToChart) {
      // Close to chart: use Euclidean distance for precise selection
      double minDistance = double.infinity;
      closestIndex = 0;

      for (int i = 0; i < pointCount; i++) {
        final pointX = i * stepSize;
        final normalizedValue = _chartDataPoints![i];
        final pointY = chartSize.height - (normalizedValue * chartSize.height);

        // Calculate Euclidean distance (scalar length)
        final dx = localPosition.dx - pointX;
        final dy = localPosition.dy - pointY;
        final distance = math.sqrt(dx * dx + dy * dy);

        if (distance < minDistance) {
          minDistance = distance;
          closestIndex = i;
        }
      }
    } else {
      // Far from chart: use x-axis only for quick selection
      closestIndex = closestByX;
    }

    // Only update state if the selected index actually changed
    if (_selectedPointIndex != closestIndex) {
      setState(() {
        _selectedPointIndex = closestIndex;
      });
    }
  }

  /// Format price value for display (up to 5 decimal places, removing trailing zeros)
  String _formatPrice(double price) {
    // Format to 5 decimal places
    final formatted = price.toStringAsFixed(5);
    // Remove trailing zeros
    if (formatted.contains('.')) {
      return formatted
          .replaceAll(RegExp(r'0+$'), '')
          .replaceAll(RegExp(r'\.$'), '');
    }
    return formatted;
  }

  /// Get the resolution label for display
  String _getResolutionLabel() {
    switch (_selectedResolution) {
      case 'day1':
        return '(Day)';
      case 'hour1':
        return '(Hour)';
      case 'min15':
        return '(15m)';
      case 'min1':
        return '(1m)';
      default:
        return '';
    }
  }

  /// Calculate the maximum width needed for price column
  /// Takes into account ALL prices in the chart data to prevent dynamic width changes
  double _calculateMaxPriceWidth() {
    const textStyle = TextStyle(
      color: Color(0xFF818181),
      fontSize: 10,
    );

    double maxWidth = 0.0;
    const textDir = ui.TextDirection.ltr;

    // Check all prices in the chart data to find the widest one
    // This ensures the width doesn't change when pointing at different parts of the chart
    if (_originalChartData != null && _originalChartData!.isNotEmpty) {
      for (final dataPoint in _originalChartData!) {
        final price = dataPoint['price'] as double?;
        if (price != null) {
          final priceText = _formatPrice(price);
          final textPainter = TextPainter(
            text: TextSpan(text: priceText, style: textStyle),
            textDirection: textDir,
          );
          textPainter.layout();
          maxWidth = math.max(maxWidth, textPainter.width);
        }
      }
    } else {
      // Fallback: check min and max prices if original data is not available
      if (_chartMinPrice != null) {
        final minPriceText = _formatPrice(_chartMinPrice!);
        final textPainter = TextPainter(
          text: TextSpan(text: minPriceText, style: textStyle),
          textDirection: textDir,
        );
        textPainter.layout();
        maxWidth = math.max(maxWidth, textPainter.width);
      }

      if (_chartMaxPrice != null) {
        final maxPriceText = _formatPrice(_chartMaxPrice!);
        final textPainter = TextPainter(
          text: TextSpan(text: maxPriceText, style: textStyle),
          textDirection: textDir,
        );
        textPainter.layout();
        maxWidth = math.max(maxWidth, textPainter.width);
      }
    }

    // Add a small padding for safety and return default if no prices
    return maxWidth > 0 ? maxWidth + 2.0 : 60.0;
  }

  /// Format timestamp based on resolution
  String _formatTimestamp(DateTime timestamp) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final yesterday = today.subtract(const Duration(days: 1));
    final timestampDate =
        DateTime(timestamp.year, timestamp.month, timestamp.day);

    switch (_selectedResolution) {
      case 'day1': // d: DD/MM/YY
        return '${timestamp.day.toString().padLeft(2, '0')}/${timestamp.month.toString().padLeft(2, '0')}/${timestamp.year.toString().substring(2)}';

      case 'hour1': // h: DD/MM
        return '${timestamp.day.toString().padLeft(2, '0')}/${timestamp.month.toString().padLeft(2, '0')}';

      case 'min15': // q: DD/MM HH:mm
        return '${timestamp.day.toString().padLeft(2, '0')}/${timestamp.month.toString().padLeft(2, '0')} ${timestamp.hour.toString().padLeft(2, '0')}:${timestamp.minute.toString().padLeft(2, '0')}';

      case 'min1': // m: 22:19, yesterday or 22:19, today
        final timeStr =
            '${timestamp.hour.toString().padLeft(2, '0')}:${timestamp.minute.toString().padLeft(2, '0')}';
        if (timestampDate == today) {
          return '$timeStr, Today';
        } else if (timestampDate == yesterday) {
          return '$timeStr, Yesterday';
        } else {
          // Fallback to date if not today or yesterday
          return '$timeStr, ${timestamp.day.toString().padLeft(2, '0')}/${timestamp.month.toString().padLeft(2, '0')}';
        }

      default:
        return timestamp.toString();
    }
  }

  /// Build selected point timestamp row aligned with the dot
  Widget _buildSelectedPointTimestampRow() {
    if (_selectedPointIndex == null ||
        _originalChartData == null ||
        _selectedPointIndex! >= _originalChartData!.length ||
        _chartDataPoints == null) {
      return const SizedBox.shrink();
    }

    final selectedData = _originalChartData![_selectedPointIndex!];
    final timestamp = selectedData['timestamp'] as DateTime?;
    if (timestamp == null) return const SizedBox.shrink();

    // Build the text widget first to measure it
    Widget timestampTextWidget;
    if (_selectedResolution == 'min1') {
      final now = DateTime.now();
      final today = DateTime(now.year, now.month, now.day);
      final yesterday = today.subtract(const Duration(days: 1));
      final timestampDate =
          DateTime(timestamp.year, timestamp.month, timestamp.day);
      final timeStr =
          '${timestamp.hour.toString().padLeft(2, '0')}:${timestamp.minute.toString().padLeft(2, '0')}';

      if (timestampDate == today) {
        timestampTextWidget = RichText(
          text: TextSpan(
            style: const TextStyle(
              fontSize: 10,
              color: Color(0xFF818181),
              height: 1.0,
            ),
            children: [
              TextSpan(text: timeStr),
              const TextSpan(
                text: ', Today',
                style: TextStyle(fontWeight: FontWeight.normal),
              ),
            ],
          ),
          textHeightBehavior: const TextHeightBehavior(
            applyHeightToFirstAscent: false,
            applyHeightToLastDescent: false,
          ),
        );
      } else if (timestampDate == yesterday) {
        timestampTextWidget = RichText(
          text: TextSpan(
            style: const TextStyle(
              fontSize: 10,
              color: Color(0xFF818181),
              height: 1.0,
            ),
            children: [
              TextSpan(text: timeStr),
              const TextSpan(
                text: ', Yesterday',
                style: TextStyle(fontWeight: FontWeight.normal),
              ),
            ],
          ),
          textHeightBehavior: const TextHeightBehavior(
            applyHeightToFirstAscent: false,
            applyHeightToLastDescent: false,
          ),
        );
      } else {
        timestampTextWidget = Text(
          _formatTimestamp(timestamp),
          style: const TextStyle(
            fontSize: 10,
            color: Color(0xFF818181),
            height: 1.0,
          ),
          textHeightBehavior: const TextHeightBehavior(
            applyHeightToFirstAscent: false,
            applyHeightToLastDescent: false,
          ),
        );
      }
    } else {
      timestampTextWidget = Text(
        _formatTimestamp(timestamp),
        style: const TextStyle(
          fontSize: 10,
          color: Color(0xFF818181),
          height: 1.0,
        ),
        textHeightBehavior: const TextHeightBehavior(
          applyHeightToFirstAscent: false,
          applyHeightToLastDescent: false,
        ),
      );
    }

    // Measure text width and calculate exact positioning
    return LayoutBuilder(
      builder: (context, constraints) {
        if (!constraints.hasBoundedWidth || constraints.maxWidth.isInfinite) {
          // Fallback to center alignment if constraints are infinite
          return Align(
            alignment: Alignment.center,
            child: timestampTextWidget,
          );
        }

        // Measure text width - need to handle RichText case
        const textStyle = TextStyle(
          fontSize: 10,
          color: Color(0xFF818181),
        );
        TextSpan textSpan;
        if (_selectedResolution == 'min1') {
          final now = DateTime.now();
          final today = DateTime(now.year, now.month, now.day);
          final yesterday = today.subtract(const Duration(days: 1));
          final timestampDate =
              DateTime(timestamp.year, timestamp.month, timestamp.day);
          final timeStr =
              '${timestamp.hour.toString().padLeft(2, '0')}:${timestamp.minute.toString().padLeft(2, '0')}';

          if (timestampDate == today) {
            textSpan = TextSpan(
              style: textStyle,
              children: [
                TextSpan(text: timeStr),
                const TextSpan(
                  text: ', Today',
                  style: TextStyle(fontWeight: FontWeight.normal),
                ),
              ],
            );
          } else if (timestampDate == yesterday) {
            textSpan = TextSpan(
              style: textStyle,
              children: [
                TextSpan(text: timeStr),
                const TextSpan(
                  text: ', Yesterday',
                  style: TextStyle(fontWeight: FontWeight.normal),
                ),
              ],
            );
          } else {
            textSpan = TextSpan(
              text: _formatTimestamp(timestamp),
              style: textStyle,
            );
          }
        } else {
          textSpan = TextSpan(
            text: _formatTimestamp(timestamp),
            style: textStyle,
          );
        }

        final textPainter = TextPainter(
          text: textSpan,
          textDirection: ui.TextDirection.ltr,
        );
        textPainter.layout();
        final textWidth = textPainter.width;

        // Calculate dot's x position on the chart
        final pointCount = _chartDataPoints!.length;
        final xRatio =
            pointCount > 1 ? _selectedPointIndex! / (pointCount - 1) : 0.0;
        final dotX = xRatio * constraints.maxWidth;

        // Calculate where text center should be (at dot position)
        final textCenterX = dotX;
        final textLeft = textCenterX - (textWidth / 2);
        final textRight = textCenterX + (textWidth / 2);

        // Determine final alignment: center on dot unless text would overflow
        double finalAlignmentX;
        if (textLeft < 0) {
          // Text would overflow left edge - stick to left
          finalAlignmentX = -1.0;
        } else if (textRight > constraints.maxWidth) {
          // Text would overflow right edge - stick to right
          finalAlignmentX = 1.0;
        } else {
          // Text fits - center on dot
          finalAlignmentX = 0.0;
        }

        // Use Transform to position text exactly at dot when centered
        if (finalAlignmentX == 0.0) {
          // Center on dot: calculate offset to move text center to dot position
          final offsetX = dotX - (constraints.maxWidth / 2);
          return Transform.translate(
            offset: Offset(offsetX, 0),
            child: Center(
              child: timestampTextWidget,
            ),
          );
        } else {
          // Edge case: align to edge
          return Align(
            alignment: Alignment(finalAlignmentX, 0.0),
            child: timestampTextWidget,
          );
        }
      },
    );
  }

  /// Build normal price column with max and min prices positioned at exact chart points
  Widget _buildNormalPriceColumn() {
    return LayoutBuilder(
      builder: (context, constraints) {
        if (!constraints.hasBoundedHeight || constraints.maxHeight.isInfinite) {
          // Fallback to spaceBetween if constraints are infinite
          return Column(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                _chartMaxPrice != null
                    ? _formatPrice(_chartMaxPrice!)
                    : "0.00000",
                style: const TextStyle(
                  color: Color(0xFF818181),
                  fontSize: 10,
                ),
                textAlign: TextAlign.right,
              ),
              Text(
                _chartMinPrice != null
                    ? _formatPrice(_chartMinPrice!)
                    : "0.00000",
                style: const TextStyle(
                  color: Color(0xFF818181),
                  fontSize: 10,
                ),
                textAlign: TextAlign.right,
              ),
            ],
          );
        }

        const textHeightBehavior = TextHeightBehavior(
          applyHeightToFirstAscent: false,
          applyHeightToLastDescent: false,
        );

        // Calculate positions: max price is at top (normalizedValue = 1.0 -> y = 0)
        // min price is at bottom (normalizedValue = 0.0 -> y = height)
        const maxPriceY = 0.0; // Max price is at top of chart
        final minPriceY =
            constraints.maxHeight; // Min price is at bottom of chart

        final maxPriceText =
            _chartMaxPrice != null ? _formatPrice(_chartMaxPrice!) : "0.00000";
        final minPriceText =
            _chartMinPrice != null ? _formatPrice(_chartMinPrice!) : "0.00000";

        // Use the same text center offset as selected point price for consistency
        const textCenterOffset = 4.5; // Same as selected point price

        // Position max price: center it at y = 0 (top)
        // textTop + textCenterOffset = 0, so textTop = -textCenterOffset
        // But we need to clamp to 0 if it would go negative
        const maxPriceTop = maxPriceY - textCenterOffset;
        const maxPriceTopClamped = maxPriceTop < 0 ? 0.0 : maxPriceTop;

        // Position min price: center it at y = height (bottom)
        // textTop + textCenterOffset = height, so textTop = height - textCenterOffset
        final minPriceTop = minPriceY - textCenterOffset;
        // Clamp to ensure text doesn't overflow bottom
        final minPriceTopClamped =
            (minPriceTop + textCenterOffset * 2) > constraints.maxHeight
                ? constraints.maxHeight - (textCenterOffset * 2)
                : minPriceTop;

        return Stack(
          children: [
            // Max price at top
            Positioned(
              top: maxPriceTopClamped,
              left: 0,
              right: 0,
              child: Text(
                maxPriceText,
                style: const TextStyle(
                  color: Color(0xFF818181),
                  fontSize: 10,
                  height: 1.0,
                ),
                textAlign: TextAlign.right,
                textHeightBehavior: textHeightBehavior,
              ),
            ),
            // Min price at bottom
            Positioned(
              top: minPriceTopClamped,
              left: 0,
              right: 0,
              child: Text(
                minPriceText,
                style: const TextStyle(
                  color: Color(0xFF818181),
                  fontSize: 10,
                  height: 1.0,
                ),
                textAlign: TextAlign.right,
                textHeightBehavior: textHeightBehavior,
              ),
            ),
          ],
        );
      },
    );
  }

  /// Build selected point price column aligned with the dot
  Widget _buildSelectedPointPriceColumn() {
    if (_selectedPointIndex == null ||
        _originalChartData == null ||
        _selectedPointIndex! >= _originalChartData!.length ||
        _chartDataPoints == null) {
      return const SizedBox.shrink();
    }

    final selectedData = _originalChartData![_selectedPointIndex!];
    final price = selectedData['price'] as double?;
    if (price == null) return const SizedBox.shrink();

    final priceText = _formatPrice(price);
    final priceTextWidget = Text(
      priceText,
      style: const TextStyle(
        color: Color(0xFF818181),
        fontSize: 10,
        height: 1.0,
      ),
      textAlign: TextAlign.right,
      textHeightBehavior: const TextHeightBehavior(
        applyHeightToFirstAscent: false,
        applyHeightToLastDescent: false,
      ),
    );

    // Measure text height and calculate exact positioning
    return LayoutBuilder(
      builder: (context, constraints) {
        if (!constraints.hasBoundedHeight || constraints.maxHeight.isInfinite) {
          // Fallback to center alignment if constraints are infinite
          return Align(
            alignment: Alignment.center,
            child: priceTextWidget,
          );
        }

        // Measure text height - use the same text style as the widget
        const textStyle = TextStyle(
          fontSize: 10,
          color: Color(0xFF818181),
          height: 1.0,
        );
        final textPainter = TextPainter(
          text: TextSpan(text: priceText, style: textStyle),
          textDirection: ui.TextDirection.ltr,
          textHeightBehavior: const TextHeightBehavior(
            applyHeightToFirstAscent: false,
            applyHeightToLastDescent: false,
          ),
        );
        textPainter.layout();

        // Get the actual visual center of the text
        // With textHeightBehavior (applyHeightToFirstAscent: false, applyHeightToLastDescent: false)
        // and height: 1.0, fontSize 10 should render as approximately 10px tall
        // The visual center might be slightly less than fontSize/2 due to how text renders
        // If text appears below dot, the center offset is too large - using a smaller value
        // Adjust this value: if text is below dot, decrease it; if above, increase it
        const textCenterOffset =
            4.5; // Slightly less than 5px (fontSize/2) to account for text rendering

        // Calculate dot's y position on the chart
        // normalizedValue: 0.0 = min (bottom), 1.0 = max (top)
        final normalizedValue = _chartDataPoints![_selectedPointIndex!];
        // Y coordinate: invert so higher values appear at top
        // This matches exactly how the dot is drawn in the painter:
        // selectedY = size.height - (points[selectedPointIndex!] * size.height)
        final dotY =
            constraints.maxHeight - (normalizedValue * constraints.maxHeight);

        // Calculate where text top should be so its center aligns with dot
        // The dot's center is at dotY, so we want the text's center at dotY
        // textTop + textCenterOffset = dotY
        // Therefore: textTop = dotY - textCenterOffset
        // Note: If text appears below dot, textCenterOffset might be too large
        // If text appears above dot, textCenterOffset might be too small
        final textTop = dotY - textCenterOffset;
        final textBottom = dotY + textCenterOffset;

        // Determine final alignment: center on dot unless text would overflow
        double finalAlignmentY;
        if (textTop < 0) {
          // Text would overflow top edge - stick to top
          finalAlignmentY = -1.0;
        } else if (textBottom > constraints.maxHeight) {
          // Text would overflow bottom edge - stick to bottom
          finalAlignmentY = 1.0;
        } else {
          // Text fits - center on dot
          finalAlignmentY = 0.0;
        }

        // Use Stack with Positioned for precise positioning
        if (finalAlignmentY == 0.0) {
          // Center on dot: position text so its visual center aligns with dot
          // The text's visual center should be at dotY
          // We position the text at textTop so that textTop + textCenterOffset = dotY
          // textTop = dotY - 5 (for fontSize 10, center is at 5px from top)
          return Stack(
            children: [
              Positioned(
                top: textTop,
                left: 0,
                right: 0,
                child: priceTextWidget,
              ),
            ],
          );
        } else {
          // Edge case: align to edge
          return Align(
            alignment: Alignment(0.0, finalAlignmentY),
            child: priceTextWidget,
          );
        }
      },
    );
  }

  /// Build timestamp widget with proper styling for min1 resolution
  Widget _buildTimestampWidget(DateTime? timestamp) {
    Widget textWidget;

    if (timestamp == null) {
      textWidget = const Text(
        "--/--",
        style: TextStyle(
          fontSize: 10,
          color: Color(0xFF818181),
          height: 1.0, // Fixed line height to prevent layout shift
        ),
        textHeightBehavior: TextHeightBehavior(
          applyHeightToFirstAscent: false,
          applyHeightToLastDescent: false,
        ),
      );
    } else if (_selectedResolution == 'min1') {
      // For min1 resolution, use RichText to style "Today"/"Yesterday" with regular font weight
      final now = DateTime.now();
      final today = DateTime(now.year, now.month, now.day);
      final yesterday = today.subtract(const Duration(days: 1));
      final timestampDate =
          DateTime(timestamp.year, timestamp.month, timestamp.day);
      final timeStr =
          '${timestamp.hour.toString().padLeft(2, '0')}:${timestamp.minute.toString().padLeft(2, '0')}';

      if (timestampDate == today) {
        textWidget = RichText(
          text: TextSpan(
            style: const TextStyle(
              fontSize: 10,
              color: Color(0xFF818181),
              height: 1.0, // Fixed line height to prevent layout shift
            ),
            children: [
              TextSpan(text: timeStr),
              const TextSpan(
                text: ', Today',
                style: TextStyle(fontWeight: FontWeight.normal),
              ),
            ],
          ),
          textHeightBehavior: const TextHeightBehavior(
            applyHeightToFirstAscent: false,
            applyHeightToLastDescent: false,
          ),
        );
      } else if (timestampDate == yesterday) {
        textWidget = RichText(
          text: TextSpan(
            style: const TextStyle(
              fontSize: 10,
              color: Color(0xFF818181),
              height: 1.0, // Fixed line height to prevent layout shift
            ),
            children: [
              TextSpan(text: timeStr),
              const TextSpan(
                text: ', yesterday',
                style: TextStyle(fontWeight: FontWeight.normal),
              ),
            ],
          ),
          textHeightBehavior: const TextHeightBehavior(
            applyHeightToFirstAscent: false,
            applyHeightToLastDescent: false,
          ),
        );
      } else {
        // Fallback for min1
        textWidget = Text(
          _formatTimestamp(timestamp),
          style: const TextStyle(
            fontSize: 10,
            color: Color(0xFF818181),
            height: 1.0, // Fixed line height to prevent layout shift
          ),
          textHeightBehavior: const TextHeightBehavior(
            applyHeightToFirstAscent: false,
            applyHeightToLastDescent: false,
          ),
        );
      }
    } else {
      // For other resolutions, check if we should show special labels
      String displayText;
      
      // Check if this is the first (oldest) timestamp and we have a last (newest) timestamp
      if (_chartFirstTimestamp != null && 
          _chartLastTimestamp != null && 
          timestamp.year == _chartFirstTimestamp!.year &&
          timestamp.month == _chartFirstTimestamp!.month &&
          timestamp.day == _chartFirstTimestamp!.day &&
          timestamp.hour == _chartFirstTimestamp!.hour &&
          timestamp.minute == _chartFirstTimestamp!.minute) {
        
        // Check if first timestamp is exactly one year ago from last timestamp (Day resolution)
        if (_selectedResolution == 'day1') {
          final oneYearAgo = DateTime(
            _chartLastTimestamp!.year - 1,
            _chartLastTimestamp!.month,
            _chartLastTimestamp!.day,
          );
          final firstDate = DateTime(
            _chartFirstTimestamp!.year,
            _chartFirstTimestamp!.month,
            _chartFirstTimestamp!.day,
          );
          
          if (firstDate.year == oneYearAgo.year &&
              firstDate.month == oneYearAgo.month &&
              firstDate.day == oneYearAgo.day) {
            displayText = 'A Year Ago';
          } else {
            displayText = _formatTimestamp(timestamp);
          }
        }
        // Check if first timestamp is exactly one month ago from last timestamp (Hour resolution)
        else if (_selectedResolution == 'hour1') {
          final lastDate = DateTime(
            _chartLastTimestamp!.year,
            _chartLastTimestamp!.month,
            _chartLastTimestamp!.day,
          );
          // Calculate one month ago, handling year rollover
          final oneMonthAgo = lastDate.month == 1
              ? DateTime(lastDate.year - 1, 12, lastDate.day)
              : DateTime(lastDate.year, lastDate.month - 1, lastDate.day);
          final firstDate = DateTime(
            _chartFirstTimestamp!.year,
            _chartFirstTimestamp!.month,
            _chartFirstTimestamp!.day,
          );
          
          if (firstDate.year == oneMonthAgo.year &&
              firstDate.month == oneMonthAgo.month &&
              firstDate.day == oneMonthAgo.day) {
            displayText = 'A Month Ago';
          } else {
            displayText = _formatTimestamp(timestamp);
          }
        } else {
          displayText = _formatTimestamp(timestamp);
        }
      } else {
        displayText = _formatTimestamp(timestamp);
      }
      
      textWidget = Text(
        displayText,
        style: const TextStyle(
          fontSize: 10,
          color: Color(0xFF818181),
          fontWeight: FontWeight.normal,
          height: 1.0, // Fixed line height to prevent layout shift
        ),
        textHeightBehavior: const TextHeightBehavior(
          applyHeightToFirstAscent: false,
          applyHeightToLastDescent: false,
        ),
      );
    }

    // Wrap in Align to ensure consistent vertical centering
    // Use textHeightBehavior to prevent baseline shifts
    return Align(
      alignment: Alignment.centerLeft,
      child: textWidget,
    );
  }

  @override
  void initState() {
    super.initState();

    final random = math.Random();
    final durationMs = 20000 + random.nextInt(14000);
    _bgController = AnimationController(
      vsync: this,
      duration: Duration(milliseconds: durationMs),
    )..repeat(reverse: true);
    _bgAnimation =
        CurvedAnimation(parent: _bgController, curve: Curves.easeInOut);
    _bgSeed = random.nextDouble();
    _noiseController = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 24),
    )..repeat(reverse: true);
    _noiseAnimation =
        Tween<double>(begin: -0.2, end: 0.2).animate(CurvedAnimation(
      parent: _noiseController,
      curve: Curves.easeInOut,
    ));

    // Fetch chart data on page load
    _fetchChartData();
    // Fetch swap amount on page load
    _fetchSwapAmount();
    // Fetch market stats on page load
    _fetchMarketStats();
    
    // Set up back button using flutter_telegram_miniapp package
    WidgetsBinding.instance.addPostFrameCallback((_) {
      try {
        final webApp = tma.WebApp();
        final eventHandler = webApp.eventHandler;
        
        // Listen to backButtonClicked event
        _backButtonSubscription = eventHandler.backButtonClicked.listen((backButton) {
          _handleBackButton();
        });
        
        // Show the back button
        Future.delayed(const Duration(milliseconds: 200), () {
          try {
            webApp.backButton.show();
          } catch (e) {
            // Ignore errors
          }
        });
      } catch (e) {
        // Ignore errors
      }
    });
  }
  
  @override
  void dispose() {
    _backButtonSubscription?.cancel();
    _bgController.dispose();
    _noiseController.dispose();
    
    // Hide back button when leaving swap page
    try {
      tma.WebApp().backButton.hide();
    } catch (e) {
      // Ignore errors
    }
    
    super.dispose();
  }

  Future<void> _fetchChartData({bool isRetry = false}) async {
    // Respect rate limiting: 1 call per second
    if (_lastChartApiCall != null) {
      final timeSinceLastCall = DateTime.now().difference(_lastChartApiCall!);
      if (timeSinceLastCall < _rateLimitDelay) {
        final waitTime = _rateLimitDelay - timeSinceLastCall;
        print(
            'Rate limiting: waiting ${waitTime.inMilliseconds}ms before API call');
        await Future.delayed(waitTime);
      }
    }

    if (!isRetry) {
      setState(() {
        _isLoadingChart = true;
        _chartError = null;
        _chartRetryCount = 0;
      });
    }

    _lastChartApiCall = DateTime.now();

    try {
      // Get time range for the selected resolution
      final timeRange = _getTimeRange();

      // Build API URL with query parameters
      // Using selected resolution, USD currency, and max time range
      final uri = Uri.parse('$_chartApiUrl/v1/jettons/$_tonAddress/price/chart')
          .replace(queryParameters: {
        'resolution': _selectedResolution,
        'currency': 'usd',
        'from': timeRange['from']!,
        'to': timeRange['to']!,
      });

      print('Fetching chart data from: $uri (attempt ${_chartRetryCount + 1})');
      final response = await http.get(uri);
      print('Chart API response status: ${response.statusCode}');

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        print('Chart API response data keys: ${data.keys.toList()}');
        final points = data['points'] as List<dynamic>?;
        print('Chart points count: ${points?.length ?? 0}');

        if (points != null && points.isNotEmpty) {
          // Extract and convert price values along with timestamps
          // Collect data points with both valid price and timestamp
          var priceDataPoints = <Map<String, dynamic>>[];
          print('Parsing ${points.length} chart points...');
          for (var point in points) {
            try {
              final valueObj = point['value'];
              if (valueObj == null) {
                print('Warning: point missing value field: $point');
                continue;
              }

              final valueStr = valueObj['value'] as String?;
              final decimals = valueObj['decimals'] as int?;

              if (valueStr == null || decimals == null) {
                print('Warning: value or decimals missing in point: $point');
                continue;
              }

              // Extract timestamp
              final timeStr = point['time'] as String?;
              if (timeStr == null) {
                print('Warning: point missing time field: $point');
                continue;
              }

              // Convert to real value: value * 10^(-decimals)
              final value = int.parse(valueStr);
              final realValue = value * math.pow(10, -decimals);

              // Parse timestamp
              DateTime? timestamp;
              try {
                timestamp = DateTime.parse(timeStr).toLocal();
              } catch (e) {
                print('Error parsing timestamp: $e, timeStr: $timeStr');
                continue;
              }

              priceDataPoints.add({
                'price': realValue.toDouble(),
                'timestamp': timestamp,
              });
            } catch (e) {
              print('Error parsing chart point: $e, point: $point');
              continue;
            }
          }

          print(
              'Successfully parsed ${priceDataPoints.length} data points from ${points.length} points');

          if (priceDataPoints.isEmpty) {
            print(
                'Error: No valid data points could be parsed from chart data');
            _handleChartError('No price data available');
            return;
          }

          // Reverse the array - API likely returns newest-first, but we need oldest-first for chart
          priceDataPoints = priceDataPoints.reversed.toList();

          // Store original data for point selection
          setState(() {
            _originalChartData =
                List<Map<String, dynamic>>.from(priceDataPoints);
            _selectedPointIndex = null;
          });

          // Extract prices and timestamps from valid data points
          var prices =
              priceDataPoints.map((dp) => dp['price'] as double).toList();

          // Extract timestamps from actual first and last valid data points
          DateTime? firstTimestamp;
          DateTime? lastTimestamp;

          if (priceDataPoints.isNotEmpty) {
            firstTimestamp = priceDataPoints.first['timestamp'] as DateTime?;
            lastTimestamp = priceDataPoints.last['timestamp'] as DateTime?;
            print(
                'Extracted timestamps - First: $firstTimestamp, Last: $lastTimestamp');
            if (firstTimestamp != null && lastTimestamp != null) {
              final duration = lastTimestamp.difference(firstTimestamp);
              print(
                  'Time range: ${duration.inDays} days, ${duration.inHours % 24} hours, ${duration.inMinutes % 60} minutes');
            }
          }

          // Normalize prices to 0.0-1.0 range for chart display
          if (prices.isNotEmpty) {
            final minPrice = prices.reduce(math.min);
            final maxPrice = prices.reduce(math.max);
            final range = maxPrice - minPrice;

            if (range > 0) {
              // Normalize prices to 0.0-1.0 range for chart display
              // minPrice -> 0.0, maxPrice -> 1.0
              final normalizedPoints = prices.map((price) {
                return (price - minPrice) / range;
              }).toList();

              setState(() {
                _chartDataPoints = normalizedPoints;
                _chartMinPrice = minPrice;
                _chartMaxPrice = maxPrice;
                _chartFirstTimestamp = firstTimestamp;
                _chartLastTimestamp = lastTimestamp;
                _isLoadingChart = false;
                _chartError = null;
                _chartRetryCount = 0;
              });
            } else {
              // All prices are the same, set to middle
              setState(() {
                _chartDataPoints = List.filled(prices.length, 0.5);
                _chartMinPrice = minPrice;
                _chartMaxPrice = maxPrice;
                _chartFirstTimestamp = firstTimestamp;
                _chartLastTimestamp = lastTimestamp;
                _isLoadingChart = false;
                _chartError = null;
                _chartRetryCount = 0;
              });
            }
          } else {
            setState(() {
              _chartDataPoints = null;
              _chartMinPrice = null;
              _chartMaxPrice = null;
              _chartFirstTimestamp = null;
              _chartLastTimestamp = null;
              _isLoadingChart = false;
            });
          }
        } else {
          _handleChartError('No chart data points received');
        }
      } else if (response.statusCode == 429) {
        // Rate limit exceeded - retry with longer delay
        print('Rate limit exceeded (429), retrying...');
        _handleChartErrorWithRetry('Rate limit exceeded. Retrying...');
      } else {
        // Other HTTP errors
        print('Chart fetch failed: ${response.statusCode}');
        _handleChartErrorWithRetry(
            'Failed to load chart (${response.statusCode})');
      }
    } catch (e) {
      print('Chart fetch error: $e');
      _handleChartErrorWithRetry('Network error: ${e.toString()}');
    }
  }

  void _handleChartError(String error) {
    setState(() {
      _chartDataPoints = null;
      _chartMinPrice = null;
      _chartMaxPrice = null;
      _chartFirstTimestamp = null;
      _chartLastTimestamp = null;
      _isLoadingChart = false;
      _chartError = error;
    });
  }

  void _handleChartErrorWithRetry(String error) {
    if (_chartRetryCount < _maxRetries) {
      _chartRetryCount++;
      // Exponential backoff: 1s, 2s, 4s, 8s, 16s
      final backoffDelay =
          Duration(seconds: math.pow(2, _chartRetryCount - 1).toInt());
      print(
          'Retrying chart fetch in ${backoffDelay.inSeconds}s (attempt $_chartRetryCount/$_maxRetries)');

      setState(() {
        _chartError = '$error Retrying in ${backoffDelay.inSeconds}s...';
      });

      Future.delayed(backoffDelay, () {
        if (mounted) {
          _fetchChartData(isRetry: true);
        }
      });
    } else {
      // Max retries reached
      setState(() {
        _chartDataPoints = null;
        _chartMinPrice = null;
        _chartMaxPrice = null;
        _chartFirstTimestamp = null;
        _chartLastTimestamp = null;
        _isLoadingChart = false;
        _chartError =
            'Failed to load chart after $_maxRetries attempts. Please try again later.';
      });
    }
  }

  Future<void> _fetchMarketStats() async {
    try {
      // For native TON, we need to use the special address
      // The API might accept the zero address or we might need a different endpoint
      final uri = Uri.parse('$_tokensApiUrl/api/v3/jettons/$_tonAddress');

      print('Fetching market stats from: $uri');
      final response = await http.get(uri);

      print('Market stats API response status: ${response.statusCode}');

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        print('Market stats response: $data');

        final marketStats = data['market_stats'] as Map<String, dynamic>?;

        if (marketStats != null) {
          setState(() {
            _priceUsd = (marketStats['price_usd'] as num?)?.toDouble();
            _mcap = (marketStats['mcap'] as num?)?.toDouble();
            _fdmc = (marketStats['fdmc'] as num?)?.toDouble();
            _volume24h = (marketStats['volume_usd_24h'] as num?)?.toDouble();
            _priceChange5m =
                (marketStats['price_change_5m'] as num?)?.toDouble();
            _priceChange1h =
                (marketStats['price_change_1h'] as num?)?.toDouble();
            _priceChange6h =
                (marketStats['price_change_6h'] as num?)?.toDouble();
            _priceChange24h =
                (marketStats['price_change_24h'] as num?)?.toDouble();
          });
          print('Market stats loaded successfully');
        } else {
          print('No market_stats in response');
        }
      } else {
        print('Market stats fetch failed: ${response.statusCode}');
        print('Response body: ${response.body}');
      }
    } catch (e) {
      print('Error fetching market stats: $e');
    }
  }

  // Helper function to format numbers
  String _formatNumber(num? value, {bool isCurrency = false}) {
    if (value == null) return '...';

    if (value >= 1000000) {
      final millions = value / 1000000;
      return isCurrency
          ? '\$${millions.toStringAsFixed(1)}M'
          : '${millions.toStringAsFixed(1)}M';
    } else if (value >= 1000) {
      final thousands = value / 1000;
      return isCurrency
          ? '\$${thousands.toStringAsFixed(1)}K'
          : '${thousands.toStringAsFixed(1)}K';
    } else {
      return isCurrency
          ? '\$${value.toStringAsFixed(0)}'
          : value.toStringAsFixed(0);
    }
  }

  // Helper function to format percentage
  String _formatPercentage(double? value) {
    if (value == null) return '...';
    final sign = value >= 0 ? '+' : '';
    return '$sign${value.toStringAsFixed(2)}%';
  }

  Color _shiftColor(Color base, double shift) {
    final hsl = HSLColor.fromColor(base);
    final newLightness = (hsl.lightness + shift).clamp(0.0, 1.0);
    final newHue = (hsl.hue + shift * 10) % 360;
    final newSaturation = (hsl.saturation + shift * 0.1).clamp(0.0, 1.0);
    return hsl
        .withLightness(newLightness)
        .withHue(newHue)
        .withSaturation(newSaturation)
        .toColor();
  }

  Future<void> _fetchSwapAmount() async {
    setState(() {
      _isLoadingSwapAmount = true;
      _swapAmountError = null;
    });

    try {
      // First, try to get USDT token address from API
      String usdtAddress = _usdtAddress;
      if (_usdtTokenAddress != null) {
        usdtAddress = _usdtTokenAddress!;
      } else {
        // Try to fetch USDT token from tokens list
        try {
          final tokenUri = Uri.parse('$_swapCoffeeApiUrl/v1/tokens/ton');
          final tokenResponse = await http.get(tokenUri);
          print('Token list response status: ${tokenResponse.statusCode}');
          if (tokenResponse.statusCode == 200) {
            final tokenData = jsonDecode(tokenResponse.body);
            print('Token list response: $tokenData');
            // The response might be a list or an object
            if (tokenData is List) {
              // Find USDT in the list
              for (var token in tokenData) {
                if (token is Map &&
                    (token['symbol'] as String?)?.toUpperCase() == 'USDT') {
                  final address = token['address'] as String?;
                  if (address != null) {
                    usdtAddress = address;
                    _usdtTokenAddress = address;
                    print('Found USDT address from token list: $usdtAddress');
                    break;
                  }
                }
              }
            } else if (tokenData is Map) {
              // Check if it's a single token object
              if ((tokenData['symbol'] as String?)?.toUpperCase() == 'USDT') {
                final address = tokenData['address'] as String?;
                if (address != null) {
                  usdtAddress = address;
                  _usdtTokenAddress = address;
                  print('Found USDT address from API: $usdtAddress');
                }
              }
            }
          } else {
            print('Token list fetch failed: ${tokenResponse.statusCode}');
            print('Response: ${tokenResponse.body}');
          }
        } catch (e) {
          print('Could not fetch USDT token address, using default: $e');
        }
      }

      final uri = Uri.parse('$_swapCoffeeApiUrl/v1/route/smart');

      // User wants to buy 1 TON, so we need to find how much USDT to pay
      // Input: USDT, Output: 1 TON
      final requestBody = {
        'input_token': {
          'blockchain': 'ton',
          'address': usdtAddress, // USDT token address
        },
        'output_token': {
          'blockchain': 'ton',
          'address': 'native', // TON native token
        },
        'output_amount': _buyAmount, // 1 TON (what we want to receive)
        'max_splits': 4,
      };

      print('Fetching swap amount with request: ${jsonEncode(requestBody)}');

      final response = await http.post(
        uri,
        headers: {
          'Content-Type': 'application/json',
        },
        body: jsonEncode(requestBody),
      );

      print('Swap API response status: ${response.statusCode}');
      print('Swap API response body: ${response.body}');

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        print('Parsed response data: $data');

        // input_amount is how much USDT we need to pay
        final inputAmount = data['input_amount'] as num?;

        if (inputAmount != null) {
          print('Found input_amount: $inputAmount');
          setState(() {
            _sellAmount = inputAmount.toDouble();
            _isLoadingSwapAmount = false;
          });
        } else {
          print(
              'No input_amount in response. Available keys: ${data.keys.toList()}');
          setState(() {
            _isLoadingSwapAmount = false;
            _swapAmountError = 'Invalid response format';
          });
        }
      } else {
        print('Swap amount fetch failed: ${response.statusCode}');
        print('Response body: ${response.body}');
        setState(() {
          _isLoadingSwapAmount = false;
          _swapAmountError = 'Failed to fetch: ${response.statusCode}';
        });
      }
    } catch (e, stackTrace) {
      print('Error fetching swap amount: $e');
      print('Stack trace: $stackTrace');
      setState(() {
        _isLoadingSwapAmount = false;
        _swapAmountError = 'Network error';
      });
    }
  }


  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: AnimatedBuilder(
        animation: _bgAnimation,
        builder: (context, child) {
          final baseShimmer =
              math.sin(2 * math.pi * (_bgAnimation.value + _bgSeed));
          final marketFactor =
              ((_priceChange24h ?? 0).abs() / 100).clamp(0.0, 0.008);
          final shimmer = (0.007 + marketFactor * 0.4) * baseShimmer;
          final baseColors = AppTheme.baseColors;
          const stopsCount = 28;
          final colors = List.generate(stopsCount, (index) {
            final progress = index / (stopsCount - 1);
            final scaled = progress * (baseColors.length - 1);
            final lowerIndex = scaled.floor();
            final upperIndex = scaled.ceil();
            final frac = scaled - lowerIndex;
            final lower =
                baseColors[lowerIndex.clamp(0, baseColors.length - 1)];
            final upper =
                baseColors[upperIndex.clamp(0, baseColors.length - 1)];
            final blended = Color.lerp(lower, upper, frac)!;
            final offset = index * 0.0015;
            return _shiftColor(blended, shimmer * (0.035 + offset));
          });
          final stops = List.generate(
              colors.length, (index) => index / (colors.length - 1));
          final rotation =
              math.sin(2 * math.pi * (_bgAnimation.value + _bgSeed)) * 0.35;
          final begin = Alignment(-0.8 + rotation, -0.7 - rotation * 0.2);
          final end = Alignment(0.9 - rotation, 0.8 + rotation * 0.2);
          return Stack(
            fit: StackFit.expand,
            children: [
              Container(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: begin,
                    end: end,
                    colors: colors,
                    stops: stops,
                  ),
                ),
              ),
              AnimatedBuilder(
                animation: _noiseAnimation,
                builder: (context, _) {
                  final alignment = Alignment(
                    0.2 + _noiseAnimation.value,
                    -0.4 + _noiseAnimation.value * 0.5,
                  );
                  return Container(
                    decoration: BoxDecoration(
                      gradient: RadialGradient(
                        center: alignment,
                        radius: 0.75,
                        colors: [
                          Colors.white.withOpacity(0.01),
                          Colors.transparent,
                        ],
                        stops: const [0.0, 1.0],
                      ),
                    ),
                  );
                },
              ),
              Container(
                decoration: BoxDecoration(
                  gradient: RadialGradient(
                    center: const Alignment(0.7, -0.6),
                    radius: 0.8,
                    colors: [
                      _shiftColor(AppTheme.radialGradientColor, shimmer * 0.4),
                      Colors.transparent,
                    ],
                    stops: const [0.0, 1.0],
                  ),
                  color: AppTheme.overlayColor.withOpacity(0.02),
                ),
              ),
              IgnorePointer(
                child: Container(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      colors: [
                        Colors.white.withOpacity(0.01),
                        Colors.transparent,
                        Colors.white.withOpacity(0.005),
                      ],
                      stops: const [0.0, 0.5, 1.0],
                    ),
                  ),
                ),
              ),
              child!,
            ],
          );
        },
        child: SafeArea(
          bottom: false,
          child: ValueListenableBuilder<bool>(
            valueListenable: GlobalLogoBar.fullscreenNotifier,
            builder: (context, isFullscreen, child) {
              return Padding(
                padding: EdgeInsets.only(
                    bottom: _getAdaptiveBottomPadding(),
                    top: GlobalLogoBar.getContentTopPadding()),
                child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 600),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.center,
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Expanded(
                        child: Padding(
                          padding: EdgeInsets.only(bottom: _getGlobalBottomBarHeight() - 30),
                          child: Column(
                            children: [
                              Expanded(
                                child: Padding(
                                  padding:
                                      const EdgeInsets.symmetric(horizontal: 15),
                                  child: SizedBox(
                                    width: double.infinity,
                                    child: Column(
                                      children: [
                                      Stack(
                                        alignment: Alignment.center,
                                        children: [
                                          Row(
                                            mainAxisAlignment:
                                                MainAxisAlignment.spaceBetween,
                                            children: [
                                              Text('Toncoin ${_getResolutionLabel()}',
                                                  style: TextStyle(
                                                    fontWeight: FontWeight.w400,
                                                    color: AppTheme.textColor,
                                                    fontSize: 20,
                                                  )),
                                              const SizedBox.shrink(),
                                              Text(
                                                _priceUsd != null
                                                    ? '\$${_formatPrice(_priceUsd!)}'
                                                    : '\$...',
                                                style: TextStyle(
                                                  fontWeight: FontWeight.w400,
                                                  color: AppTheme.textColor,
                                                  fontSize: 20,
                                                ),
                                              ),
                                            ],
                                          ),
                                          Padding(
                                            padding: const EdgeInsets.symmetric(horizontal: 5),
                                            child: Row(
                                              mainAxisSize: MainAxisSize.min,
                                              children: [
                                                GestureDetector(
                                                  onTap: () {
                                                    setState(() {
                                                      _selectedResolution =
                                                          _resolutionMap['d']!;
                                                    });
                                                    _fetchChartData();
                                                  },
                                                  child: Container(
                                                    height: 20,
                                                    constraints: const BoxConstraints(minWidth: 20),
                                                    padding: const EdgeInsets.symmetric(horizontal: 10),
                                                    alignment: Alignment.center,
                                                    child: Text(
                                                      "d",
                                                      style: TextStyle(
                                                        fontWeight:
                                                            _selectedResolution ==
                                                                    _resolutionMap[
                                                                        'd']
                                                                ? FontWeight.normal
                                                                : FontWeight.w500,
                                                        color:
                                                            _selectedResolution ==
                                                                    _resolutionMap[
                                                                        'd']
                                                                ? AppTheme.textColor
                                                                : const Color(
                                                                    0xFF818181),
                                                        fontSize: 15,
                                                      ),
                                                    ),
                                                  ),
                                                ),
                                                GestureDetector(
                                                  onTap: () {
                                                    setState(() {
                                                      _selectedResolution =
                                                          _resolutionMap['h']!;
                                                    });
                                                    _fetchChartData();
                                                  },
                                                  child: Container(
                                                    height: 20,
                                                    constraints: const BoxConstraints(minWidth: 20),
                                                    padding: const EdgeInsets.symmetric(horizontal: 10),
                                                    alignment: Alignment.center,
                                                    child: Text(
                                                      "h",
                                                      style: TextStyle(
                                                        fontWeight:
                                                            _selectedResolution ==
                                                                    _resolutionMap[
                                                                        'h']
                                                                ? FontWeight.normal
                                                                : FontWeight.w500,
                                                        color:
                                                            _selectedResolution ==
                                                                    _resolutionMap[
                                                                        'h']
                                                                ? AppTheme.textColor
                                                                : const Color(
                                                                    0xFF818181),
                                                        fontSize: 15,
                                                      ),
                                                    ),
                                                  ),
                                                ),
                                                GestureDetector(
                                                  onTap: () {
                                                    setState(() {
                                                      _selectedResolution =
                                                          _resolutionMap['q']!;
                                                    });
                                                    _fetchChartData();
                                                  },
                                                  child: Container(
                                                    height: 20,
                                                    constraints: const BoxConstraints(minWidth: 20),
                                                    padding: const EdgeInsets.symmetric(horizontal: 10),
                                                    alignment: Alignment.center,
                                                    child: Text(
                                                      "q",
                                                      style: TextStyle(
                                                        fontWeight:
                                                            _selectedResolution ==
                                                                    _resolutionMap[
                                                                        'q']
                                                                ? FontWeight.normal
                                                                : FontWeight.w500,
                                                        color:
                                                            _selectedResolution ==
                                                                    _resolutionMap[
                                                                        'q']
                                                                ? AppTheme.textColor
                                                                : const Color(
                                                                    0xFF818181),
                                                        fontSize: 15,
                                                      ),
                                                    ),
                                                  ),
                                                ),
                                                GestureDetector(
                                                  onTap: () {
                                                    setState(() {
                                                      _selectedResolution =
                                                          _resolutionMap['m']!;
                                                    });
                                                    _fetchChartData();
                                                  },
                                                  child: Container(
                                                    height: 20,
                                                    constraints: const BoxConstraints(minWidth: 20),
                                                    padding: const EdgeInsets.symmetric(horizontal: 10),
                                                    alignment: Alignment.center,
                                                    child: Text(
                                                      "m",
                                                      style: TextStyle(
                                                        fontWeight:
                                                            _selectedResolution ==
                                                                    _resolutionMap[
                                                                        'm']
                                                                ? FontWeight.normal
                                                                : FontWeight.w500,
                                                        color:
                                                            _selectedResolution ==
                                                                    _resolutionMap[
                                                                        'm']
                                                                ? AppTheme.textColor
                                                                : const Color(
                                                                    0xFF818181),
                                                        fontSize: 15,
                                                      ),
                                                    ),
                                                  ),
                                                ),
                                              ],
                                            ),
                                          ),
                                        ],
                                      ),
                                      const SizedBox(height: 15),
                                      Row(
                                        mainAxisAlignment:
                                            MainAxisAlignment.spaceAround,
                                        children: [
                                          Column(
                                            crossAxisAlignment:
                                                CrossAxisAlignment.center,
                                            children: [
                                              Text(
                                                'MCAP',
                                                style: TextStyle(
                                                  fontWeight: FontWeight.w400,
                                                  color: AppTheme.textColor,
                                                  fontSize: 12,
                                                ),
                                              ),
                                              const SizedBox(height: 5),
                                              Text(
                                                _formatNumber(_mcap,
                                                    isCurrency: true),
                                                style: const TextStyle(
                                                  fontWeight: FontWeight.w300,
                                                  color: Color(0xFF818181),
                                                  fontSize: 12,
                                                ),
                                              ),
                                            ],
                                          ),
                                          Column(
                                            crossAxisAlignment:
                                                CrossAxisAlignment.center,
                                            children: [
                                              Text(
                                                'FDMC',
                                                style: TextStyle(
                                                  fontWeight: FontWeight.w400,
                                                  color: AppTheme.textColor,
                                                  fontSize: 12,
                                                ),
                                              ),
                                              const SizedBox(height: 5),
                                              Text(
                                                _formatNumber(_fdmc,
                                                    isCurrency: true),
                                                style: const TextStyle(
                                                  fontWeight: FontWeight.w300,
                                                  color: Color(0xFF818181),
                                                  fontSize: 12,
                                                ),
                                              ),
                                            ],
                                          ),
                                          Column(
                                            crossAxisAlignment:
                                                CrossAxisAlignment.center,
                                            children: [
                                              Text(
                                                'VOL',
                                                style: TextStyle(
                                                  fontWeight: FontWeight.w400,
                                                  color: AppTheme.textColor,
                                                  fontSize: 12,
                                                ),
                                              ),
                                              const SizedBox(height: 5),
                                              Text(
                                                _formatNumber(_volume24h,
                                                    isCurrency: true),
                                                style: const TextStyle(
                                                  fontWeight: FontWeight.w300,
                                                  color: Color(0xFF818181),
                                                  fontSize: 12,
                                                ),
                                              ),
                                            ],
                                          ),
                                          Column(
                                            crossAxisAlignment:
                                                CrossAxisAlignment.center,
                                            children: [
                                              Text(
                                                '5M',
                                                style: TextStyle(
                                                  fontWeight: FontWeight.w400,
                                                  color: AppTheme.textColor,
                                                  fontSize: 12,
                                                ),
                                              ),
                                              const SizedBox(height: 5),
                                              Text(
                                                _formatPercentage(
                                                    _priceChange5m),
                                                style: const TextStyle(
                                                  fontWeight: FontWeight.w300,
                                                  color: Color(0xFF818181),
                                                  fontSize: 12,
                                                ),
                                              ),
                                            ],
                                          ),
                                          Column(
                                            crossAxisAlignment:
                                                CrossAxisAlignment.center,
                                            children: [
                                              Text(
                                                '1H',
                                                style: TextStyle(
                                                  fontWeight: FontWeight.w400,
                                                  color: AppTheme.textColor,
                                                  fontSize: 12,
                                                ),
                                              ),
                                              const SizedBox(height: 5),
                                              Text(
                                                _formatPercentage(
                                                    _priceChange1h),
                                                style: const TextStyle(
                                                  fontWeight: FontWeight.w300,
                                                  color: Color(0xFF818181),
                                                  fontSize: 12,
                                                ),
                                              ),
                                            ],
                                          ),
                                          Column(
                                            crossAxisAlignment:
                                                CrossAxisAlignment.center,
                                            children: [
                                              Text(
                                                '6H',
                                                style: TextStyle(
                                                  fontWeight: FontWeight.w400,
                                                  color: AppTheme.textColor,
                                                  fontSize: 12,
                                                ),
                                              ),
                                              const SizedBox(height: 5),
                                              Text(
                                                _formatPercentage(
                                                    _priceChange6h),
                                                style: const TextStyle(
                                                  fontWeight: FontWeight.w300,
                                                  color: Color(0xFF818181),
                                                  fontSize: 12,
                                                ),
                                              ),
                                            ],
                                          ),
                                          Column(
                                            crossAxisAlignment:
                                                CrossAxisAlignment.center,
                                            children: [
                                              Text(
                                                '24H',
                                                style: TextStyle(
                                                  fontWeight: FontWeight.w400,
                                                  color: AppTheme.textColor,
                                                  fontSize: 12,
                                                ),
                                              ),
                                              const SizedBox(height: 5),
                                              Text(
                                                _formatPercentage(
                                                    _priceChange24h),
                                                style: const TextStyle(
                                                  fontWeight: FontWeight.w300,
                                                  color: Color(0xFF818181),
                                                  fontSize: 12,
                                                ),
                                              ),
                                            ],
                                          ),
                                        ],
                                      ),
                                      const SizedBox(height: 15),
                                      Expanded(
                                        child: Row(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.start,
                                          children: [
                                            Expanded(
                                              child: Column(
                                                children: [
                                                  Expanded(
                                                    child: _isLoadingChart
                                                          ? const Center(
                                                              child: SizedBox(
                                                                width: 20,
                                                                height: 20,
                                                                child:
                                                                    CircularProgressIndicator(
                                                                  strokeWidth:
                                                                      2,
                                                                  valueColor:
                                                                      AlwaysStoppedAnimation<
                                                                          Color>(
                                                                    Color(
                                                                        0xFF818181),
                                                                  ),
                                                                ),
                                                              ),
                                                            )
                                                          : (_chartDataPoints !=
                                                                      null &&
                                                                  _chartDataPoints!
                                                                      .isNotEmpty)
                                                              ? LayoutBuilder(
                                                                  builder: (context,
                                                                      constraints) {
                                                                    final chartSize =
                                                                        Size(
                                                                      constraints.maxWidth.isFinite &&
                                                                              constraints.maxWidth >
                                                                                  0
                                                                          ? constraints
                                                                              .maxWidth
                                                                          : 100.0,
                                                                      constraints.maxHeight.isFinite &&
                                                                              constraints.maxHeight >
                                                                                  0
                                                                          ? constraints
                                                                              .maxHeight
                                                                          : 100.0,
                                                                    );

                                                                    return MouseRegion(
                                                                      onHover:
                                                                          (event) {
                                                                        _handleChartPointer(
                                                                            event.localPosition,
                                                                            chartSize);
                                                                      },
                                                                      onExit:
                                                                          (event) {
                                                                        setState(
                                                                            () {
                                                                          _selectedPointIndex =
                                                                              null;
                                                                        });
                                                                      },
                                                                      child:
                                                                          GestureDetector(
                                                                        onPanUpdate:
                                                                            (details) {
                                                                          _handleChartPointer(
                                                                              details.localPosition,
                                                                              chartSize);
                                                                        },
                                                                        onPanEnd:
                                                                            (details) {
                                                                          setState(
                                                                              () {
                                                                            _selectedPointIndex =
                                                                                null;
                                                                          });
                                                                        },
                                                                        onPanCancel:
                                                                            () {
                                                                          setState(
                                                                              () {
                                                                            _selectedPointIndex =
                                                                                null;
                                                                          });
                                                                        },
                                                                        child:
                                                                            SizedBox.expand(
                                                                          child: CustomPaint(
                                                                            painter:
                                                                                DiagonalLinePainter(
                                                                              dataPoints:
                                                                                  _chartDataPoints,
                                                                              selectedPointIndex:
                                                                                  _selectedPointIndex,
                                                                            ),
                                                                          ),
                                                                        ),
                                                                      ),
                                                                    );
                                                                  },
                                                                )
                                                              : Container(
                                                                  // Transparent container to maintain layout
                                                                  color: Colors
                                                                      .transparent,
                                                                  child: _chartError !=
                                                                          null
                                                                      ? Center(
                                                                          child:
                                                                              Padding(
                                                                            padding:
                                                                                const EdgeInsets.all(8.0),
                                                                            child:
                                                                                Text(
                                                                              _chartError!,
                                                                              style: const TextStyle(
                                                                                fontSize: 10,
                                                                                color: Color(0xFF818181),
                                                                              ),
                                                                              textAlign: TextAlign.center,
                                                                            ),
                                                                          ),
                                                                        )
                                                                      : null,
                                                                ),
                                                  ),
                                                  const SizedBox(height: 5.0),
                                                  SizedBox(
                                                    height:
                                                        15.0, // Fixed height to prevent layout shift
                                                    child: _selectedPointIndex != null &&
                                                            _originalChartData !=
                                                                null &&
                                                            _selectedPointIndex! <
                                                                _originalChartData!
                                                                    .length
                                                        ? _buildSelectedPointTimestampRow()
                                                        : Row(
                                                            mainAxisAlignment:
                                                                MainAxisAlignment
                                                                    .spaceBetween,
                                                            crossAxisAlignment:
                                                                CrossAxisAlignment
                                                                    .center,
                                                            children: [
                                                              _buildTimestampWidget(
                                                                  _chartFirstTimestamp),
                                                              _buildTimestampWidget(
                                                                  _chartLastTimestamp),
                                                            ],
                                                          ),
                                                  )
                                                ],
                                              ),
                                            ),
                                            const SizedBox(width: 5),
                                            // Price column: height = chart space (from max point to min point), top-aligned
                                            // The chart is in an Expanded Column, so we use LayoutBuilder
                                            // to get the actual chart height
                                            LayoutBuilder(
                                              builder:
                                                  (context, rowConstraints) {
                                                // The Row contains: Expanded Column + SizedBox(width: 5) + price column
                                                // The Column contains: Expanded (chart) + SizedBox(5px) + SizedBox(15px timestamps)
                                                // Chart space = Expanded widget height = Row height - 5px (spacing) - 15px (timestamps)
                                                // Price column height = chart space (full height from max to min point)
                                                final chartSpaceHeight =
                                                    rowConstraints.maxHeight -
                                                        5.0 -
                                                        15.0;

                                                return SizedBox(
                                                  width:
                                                      _calculateMaxPriceWidth(),
                                                  height: chartSpaceHeight,
                                                  child: _selectedPointIndex != null &&
                                                          _originalChartData !=
                                                              null &&
                                                          _selectedPointIndex! <
                                                              _originalChartData!
                                                                  .length
                                                      ? _buildSelectedPointPriceColumn()
                                                      : _buildNormalPriceColumn(),
                                                );
                                              },
                                            ),
                                          ],
                                        ),
                                      )
                                    ],
                                  ),
                                ),
                              ),
                            ),
                            Container(
                              width: double.infinity,
                              padding: const EdgeInsets.only(
                                  top: 20, bottom: 0, left: 15, right: 15),
                              child: Column(children: [
                                Row(
                                  mainAxisAlignment:
                                      MainAxisAlignment.spaceBetween,
                                  crossAxisAlignment: CrossAxisAlignment.center,
                                  children: [
                                    Text('Buy',
                                        style: TextStyle(
                                          fontWeight: FontWeight.w400,
                                          color: AppTheme.textColor,
                                          fontSize: 20,
                                        )),
                                    SizedBox(
                                      height: 20,
                                      child: SingleChildScrollView(
                                        scrollDirection: Axis.horizontal,
                                        child: Row(
                                          children: [
                                            Image.asset('assets/sample/1.png',
                                                width: 20,
                                                height: 20,
                                                fit: BoxFit.contain),
                                            const SizedBox(width: 5),
                                            Image.asset('assets/sample/2.png',
                                                width: 20,
                                                height: 20,
                                                fit: BoxFit.contain),
                                            const SizedBox(width: 5),
                                            Image.asset('assets/sample/3.png',
                                                width: 20,
                                                height: 20,
                                                fit: BoxFit.contain),
                                            const SizedBox(width: 5),
                                            Image.asset('assets/sample/4.png',
                                                width: 20,
                                                height: 20,
                                                fit: BoxFit.contain),
                                            const SizedBox(width: 5),
                                            Image.asset('assets/sample/5.png',
                                                width: 20,
                                                height: 20,
                                                fit: BoxFit.contain),
                                          ],
                                        ),
                                      ),
                                    )
                                  ],
                                ),
                                const SizedBox(height: 15),
                                Row(
                                  mainAxisAlignment:
                                      MainAxisAlignment.spaceBetween,
                                  crossAxisAlignment: CrossAxisAlignment.center,
                                  children: [
                                    Text(
                                        _buyAmount
                                            .toStringAsFixed(6)
                                            .replaceAll(RegExp(r'0+$'), '')
                                            .replaceAll(RegExp(r'\.$'), ''),
                                        style: TextStyle(
                                          fontWeight: FontWeight.w500,
                                          fontSize: 20,
                                          color: AppTheme.textColor,
                                        )),
                                    Row(
                                      mainAxisSize: MainAxisSize.min,
                                      crossAxisAlignment:
                                          CrossAxisAlignment.center,
                                      children: [
                                        Image.asset('assets/sample/ton.png',
                                            width: 20,
                                            height: 20,
                                            fit: BoxFit.contain),
                                        const SizedBox(width: 8),
                                        Text(_buyCurrency.toLowerCase(),
                                            style: TextStyle(
                                              fontWeight: FontWeight.w500,
                                              color: AppTheme.textColor,
                                              fontSize: 20,
                                            )),
                                        const SizedBox(width: 8),
                                        SvgPicture.asset(
                                          AppTheme.isLightTheme
                                              ? 'assets/icons/select_light.svg'
                                              : 'assets/icons/select_dark.svg',
                                          width: 5,
                                          height: 10,
                                        ),
                                      ],
                                    )
                                  ],
                                ),
                                const SizedBox(height: 15),
                                const Row(
                                    mainAxisAlignment:
                                        MainAxisAlignment.spaceBetween,
                                    children: [
                                      Text(r'$1',
                                          style: TextStyle(
                                            fontWeight: FontWeight.w400,
                                            fontSize: 15,
                                            color: Color(0xFF818181),
                                          )),
                                      Text('TON',
                                          style: TextStyle(
                                            fontWeight: FontWeight.w400,
                                            fontSize: 15,
                                            color: Color(0xFF818181),
                                          )),
                                    ]),
                              ]),
                            ),
                            Container(
                              width: double.infinity,
                              padding: const EdgeInsets.symmetric(
                                  vertical: 0, horizontal: 15),
                              child: SvgPicture.asset(
                                AppTheme.isLightTheme
                                    ? 'assets/icons/rotate_light.svg'
                                    : 'assets/icons/rotate_dark.svg',
                                width: 30,
                                height: 30,
                              ),
                            ),
                            Container(
                              width: double.infinity,
                              padding: const EdgeInsets.only(
                                  top: 15, bottom: 15, left: 15, right: 15),
                              child: Column(children: [
                                Row(
                                  mainAxisAlignment:
                                      MainAxisAlignment.spaceBetween,
                                  crossAxisAlignment: CrossAxisAlignment.center,
                                  children: [
                                    Text('Sell',
                                        style: TextStyle(
                                          fontWeight: FontWeight.w400,
                                          color: AppTheme.textColor,
                                          fontSize: 20,
                                        )),
                                    SizedBox(
                                      height: 20,
                                      child: SingleChildScrollView(
                                        scrollDirection: Axis.horizontal,
                                        child: Row(
                                          children: [
                                            Image.asset('assets/sample/1.png',
                                                width: 20,
                                                height: 20,
                                                fit: BoxFit.contain),
                                            const SizedBox(width: 5),
                                            Image.asset('assets/sample/2.png',
                                                width: 20,
                                                height: 20,
                                                fit: BoxFit.contain),
                                            const SizedBox(width: 5),
                                            Image.asset('assets/sample/3.png',
                                                width: 20,
                                                height: 20,
                                                fit: BoxFit.contain),
                                            const SizedBox(width: 5),
                                            Image.asset('assets/sample/4.png',
                                                width: 20,
                                                height: 20,
                                                fit: BoxFit.contain),
                                            const SizedBox(width: 5),
                                            Image.asset('assets/sample/5.png',
                                                width: 20,
                                                height: 20,
                                                fit: BoxFit.contain),
                                          ],
                                        ),
                                      ),
                                    )
                                  ],
                                ),
                                const SizedBox(height: 15),
                                Row(
                                  mainAxisAlignment:
                                      MainAxisAlignment.spaceBetween,
                                  crossAxisAlignment: CrossAxisAlignment.center,
                                  children: [
                                    Text(
                                        _isLoadingSwapAmount
                                            ? '...'
                                            : (_swapAmountError != null
                                                ? 'Error'
                                                : (_sellAmount != null
                                                    ? _sellAmount!
                                                        .toStringAsFixed(6)
                                                        .replaceAll(
                                                            RegExp(r'0+$'), '')
                                                        .replaceAll(
                                                            RegExp(r'\.$'), '')
                                                    : '1')),
                                        style: TextStyle(
                                          fontWeight: FontWeight.w500,
                                          fontSize: 20,
                                          color: AppTheme.textColor,
                                        )),
                                    Row(
                                      mainAxisSize: MainAxisSize.min,
                                      crossAxisAlignment:
                                          CrossAxisAlignment.center,
                                      children: [
                                        Image.asset('assets/sample/usdt.png',
                                            width: 20,
                                            height: 20,
                                            fit: BoxFit.contain),
                                        const SizedBox(width: 8),
                                        Text(_sellCurrency.toLowerCase(),
                                            style: TextStyle(
                                              fontWeight: FontWeight.w500,
                                              color: AppTheme.textColor,
                                              fontSize: 20,
                                            )),
                                        const SizedBox(width: 8),
                                        SvgPicture.asset(
                                          AppTheme.isLightTheme
                                              ? 'assets/icons/select_light.svg'
                                              : 'assets/icons/select_dark.svg',
                                          width: 5,
                                          height: 10,
                                        ),
                                      ],
                                    )
                                  ],
                                ),
                                const SizedBox(height: 15),
                                const Row(
                                    mainAxisAlignment:
                                        MainAxisAlignment.spaceBetween,
                                    children: [
                                      Text(r'$1',
                                          style: TextStyle(
                                            fontWeight: FontWeight.w400,
                                            fontSize: 15,
                                            color: Color(0xFF818181),
                                          )),
                                      Text('TON',
                                          style: TextStyle(
                                            fontWeight: FontWeight.w400,
                                            fontSize: 15,
                                            color: Color(0xFF818181),
                                          )),
                                    ]),
                              ]),
                            ),
                            Container(
                              margin: const EdgeInsets.only(
                                  bottom: 10, right: 15, left: 15),
                              padding: const EdgeInsets.symmetric(
                                  vertical: 10, horizontal: 15),
                              decoration: BoxDecoration(
                                color: AppTheme.buttonBackgroundColor,
                                borderRadius: BorderRadius.circular(5),
                              ),
                              child: Row(
                                mainAxisAlignment: MainAxisAlignment.center,
                                crossAxisAlignment: CrossAxisAlignment.center,
                                children: [
                                  Center(
                                    child: Text(
                                      'Add wallet',
                                      style: TextStyle(
                                        fontWeight: FontWeight.w700,
                                        color: AppTheme.buttonTextColor,
                                        fontSize: 15,
                                        height: 20 / 15,
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
              );
            },
          ),
        ),
      ),
    );
  }
}

class NewPage extends StatefulWidget {
  final String title;

  const NewPage({super.key, required this.title});

  @override
  State<NewPage> createState() => _NewPageState();
}

class QAPair {
  final String question;
  String? response;
  bool isLoading;
  String? error;
  AnimationController? dotsController;

  QAPair({
    required this.question,
    this.response,
    this.isLoading = true,
    this.error,
    this.dotsController,
  });
}

class _NewPageState extends State<NewPage> with TickerProviderStateMixin {
  // Helper method to calculate adaptive bottom padding
  double _getAdaptiveBottomPadding() {
    final service = TelegramSafeAreaService();
    final safeAreaInset = service.getSafeAreaInset();

    // Formula: bottom SafeAreaInset + 30px
    final bottomPadding = safeAreaInset.bottom + 30;
    return bottomPadding;
  }

  // List to store all Q&A pairs
  final List<QAPair> _qaPairs = [];
  final String _apiUrl = 'https://xp7k-production.up.railway.app';
  // API Key - read from window.APP_CONFIG.API_KEY at runtime
  String? _apiKey;
  bool _isLoadingApiKey = false;
  late AnimationController _dotsController;


  // Scroll controller for auto-scrolling to new responses
  final ScrollController _scrollController = ScrollController();

  // Track if auto-scrolling is enabled (disabled when user manually scrolls)
  bool _autoScrollEnabled = true;

  // Scroll progress for custom scrollbar
  double _scrollProgress = 0.0;
  double _scrollIndicatorHeight = 1.0;

  @override
  void initState() {
    super.initState();
    _dotsController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1200),
    )..repeat();

    // Load API key from Vercel serverless function (reads from env vars at runtime)
    // Don't await here - it will load in the background
    _loadApiKey();

    // Listen to scroll changes to detect manual scrolling and update scrollbar
    _scrollController.addListener(() {
      if (_scrollController.hasClients) {
        final position = _scrollController.position;
        final maxScroll = position.maxScrollExtent;
        final currentScroll = position.pixels;
        final viewportHeight = position.viewportDimension;
        final totalHeight = viewportHeight + maxScroll;

        // Update scrollbar
        if (maxScroll > 0 && totalHeight > 0) {
          final indicatorHeight =
              (viewportHeight / totalHeight).clamp(0.0, 1.0);
          final scrollPosition = (currentScroll / maxScroll).clamp(0.0, 1.0);
          setState(() {
            _scrollIndicatorHeight = indicatorHeight;
            _scrollProgress = scrollPosition;
          });
        } else {
          setState(() {
            _scrollProgress = 0.0;
            _scrollIndicatorHeight = 1.0;
          });
        }

        // If user is near the bottom (within 50px), re-enable auto-scroll
        // Otherwise, disable auto-scroll if user scrolled up
        if (maxScroll > 0) {
          final distanceFromBottom = maxScroll - currentScroll;
          if (distanceFromBottom < 50) {
            // User is near bottom, enable auto-scroll
            // Also check if any response is still loading/streaming
            final hasLoadingContent = _qaPairs.any((pair) => pair.isLoading);
            if (!_autoScrollEnabled || hasLoadingContent) {
              setState(() {
                _autoScrollEnabled = true;
              });
              // If content is still streaming and user is at bottom, scroll immediately
              if (hasLoadingContent) {
                WidgetsBinding.instance.addPostFrameCallback((_) {
                  if (_scrollController.hasClients) {
                    final currentMaxScroll =
                        _scrollController.position.maxScrollExtent;
                    if (currentMaxScroll > 0) {
                      _scrollController.animateTo(
                        currentMaxScroll,
                        duration: const Duration(milliseconds: 100),
                        curve: Curves.easeOut,
                      );
                    }
                  }
                });
              }
            }
          } else if (distanceFromBottom > 100) {
            // User scrolled up significantly, disable auto-scroll
            if (_autoScrollEnabled) {
              setState(() {
                _autoScrollEnabled = false;
              });
            }
          }
        }
      }
    });

    // Add initial Q&A pair with the title
    setState(() {
      _qaPairs.add(QAPair(
        question: widget.title,
        isLoading: true,
        dotsController: _dotsController,
      ));
    });
    // Fetch response after the first frame
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _qaPairs.isNotEmpty) {
        _fetchAIResponse(_qaPairs.last);
      }
    });
  }

  @override
  void dispose() {
    _dotsController.dispose();
    _scrollController.dispose();
    // Dispose all animation controllers
    for (var pair in _qaPairs) {
      pair.dotsController?.dispose();
    }
    super.dispose();
  }

  Future<void> _loadApiKey() async {
    // Prevent multiple simultaneous loads
    if (_isLoadingApiKey) {
      print('API key load already in progress, waiting...');
      // Wait for existing load to complete
      while (_isLoadingApiKey) {
        await Future.delayed(const Duration(milliseconds: 50));
      }
      return;
    }

    _isLoadingApiKey = true;
    try {
      // First, try to load from .env file (for local development)
      try {
        final envApiKey = dotenv.env['API_KEY'];
        if (envApiKey != null && envApiKey.isNotEmpty) {
          _apiKey = envApiKey;
          if (mounted) {
            setState(() {
              _apiKey = envApiKey;
            });
          }
          print('API key loaded from .env file (local development)');
          _isLoadingApiKey = false;
          return;
        }
      } catch (e) {
        print('No API key found in .env file: $e');
      }

      // Try to fetch API key from Vercel serverless function
      // This reads from Vercel's environment variables at runtime
      final uri = Uri.parse('/api/config');

      try {
        final response = await http.get(uri);

        if (response.statusCode == 200) {
          final data = jsonDecode(response.body);
          final apiKey = data['apiKey'] as String?;

          if (apiKey != null && apiKey.isNotEmpty) {
            _apiKey = apiKey;
            if (mounted) {
              setState(() {
                _apiKey = apiKey;
              });
            }
            print(
                'API key loaded from Vercel environment variable: ${apiKey.substring(0, apiKey.length > 10 ? 10 : apiKey.length)}...');
            _isLoadingApiKey = false;
            return;
          } else {
            print('API key from serverless function is empty or null');
          }
        } else {
          print('API key fetch failed with status: ${response.statusCode}');
        }
      } catch (e) {
        print('Error fetching API key from serverless function: $e');
      }

      // Fallback: try to read from window.APP_CONFIG (for local development)
      try {
        final apiKeyJs = js.context.callMethod(
            'eval', ['window.APP_CONFIG && window.APP_CONFIG.API_KEY || ""']);

        if (apiKeyJs != null) {
          final apiKey = apiKeyJs.toString();
          if (apiKey.isNotEmpty && apiKey != '{{API_KEY}}') {
            _apiKey = apiKey;
            if (mounted) {
              setState(() {
                _apiKey = apiKey;
              });
            }
            print('API key loaded from window.APP_CONFIG (fallback)');
            _isLoadingApiKey = false;
            return;
          }
        }
      } catch (e) {
        print('Error reading API key from window: $e');
      }

      print('API key not found');
      _apiKey = '';
      if (mounted) {
        setState(() {
          _apiKey = '';
        });
      }
    } catch (e) {
      print('Error loading API key: $e');
      _apiKey = '';
      if (mounted) {
        setState(() {
          _apiKey = '';
        });
      }
    } finally {
      _isLoadingApiKey = false;
    }
  }

  Future<void> _fetchAIResponse(QAPair pair) async {
    try {
      // Wait for API key to be loaded if not set
      if (_apiKey == null || _apiKey!.isEmpty) {
        print('API key not set, loading...');
        await _loadApiKey();
        // Wait a bit more to ensure state is updated
        await Future.delayed(const Duration(milliseconds: 200));
        print(
            'After loading, API key is: ${_apiKey != null && _apiKey!.isNotEmpty ? "set (length: ${_apiKey!.length})" : "empty"}');
      }

      if (_apiKey == null || _apiKey!.isEmpty) {
        print('API key still empty after loading attempt');
        if (mounted) {
          setState(() {
            pair.error =
                'API key not configured. Please set API_KEY environment variable.';
            pair.isLoading = false;
            pair.dotsController?.stop();
          });
        }
        return;
      }

      print('Using API key for request (length: ${_apiKey!.length})');

      final request = http.Request(
        'POST',
        Uri.parse('$_apiUrl/api/chat'),
      );
      request.headers['Content-Type'] = 'application/json';
      request.headers['X-API-Key'] = _apiKey ?? '';
      request.body = jsonEncode({'message': pair.question});

      final client = http.Client();
      final streamedResponse = await client.send(request);

      if (streamedResponse.statusCode == 200) {
        String accumulatedResponse = '';
        String? finalResponse;
        String buffer = ''; // Buffer for incomplete lines

        // Process the stream line by line as it arrives
        await for (final chunk
            in streamedResponse.stream.transform(utf8.decoder)) {
          buffer += chunk;
          final lines = buffer.split('\n');

          // Keep the last incomplete line in buffer
          if (lines.isNotEmpty) {
            buffer = lines.removeLast();
          } else {
            buffer = '';
          }

          for (final line in lines) {
            if (line.trim().isEmpty) continue;
            try {
              final data = jsonDecode(line);

              // Check for final complete response
              if (data['response'] != null && data['done'] == true) {
                finalResponse = data['response'] as String;
                // Update with final complete response
                if (mounted) {
                  setState(() {
                    pair.response = finalResponse;
                    pair.isLoading = false;
                    pair.dotsController?.stop();
                  });
                }
              }
              // Process tokens as they arrive (for streaming effect)
              else if (data['token'] != null) {
                accumulatedResponse += data['token'] as String;
                // Update UI immediately with each token (streaming effect)
                if (mounted && finalResponse == null) {
                  setState(() {
                    pair.response = accumulatedResponse;
                    pair.isLoading = false;
                    pair.dotsController?.stop();
                  });
                  // Auto-scroll to bottom as response streams in, only if auto-scroll is enabled
                  if (_autoScrollEnabled) {
                    WidgetsBinding.instance.addPostFrameCallback((_) {
                      if (_scrollController.hasClients) {
                        final maxScroll =
                            _scrollController.position.maxScrollExtent;
                        if (maxScroll > 0) {
                          _scrollController.animateTo(
                            maxScroll,
                            duration: const Duration(milliseconds: 100),
                            curve: Curves.easeOut,
                          );
                        }
                      }
                    });
                  }
                }
              }
              // Check for errors
              else if (data['error'] != null) {
                if (mounted) {
                  setState(() {
                    pair.error = data['error'] as String;
                    pair.isLoading = false;
                    pair.dotsController?.stop();
                  });
                }
                client.close();
                return;
              }
            } catch (e) {
              // Skip invalid JSON lines (might be partial chunks)
              continue;
            }
          }
        }

        // Process any remaining buffer content
        if (buffer.trim().isNotEmpty) {
          try {
            final data = jsonDecode(buffer);
            if (data['response'] != null && data['done'] == true) {
              finalResponse = data['response'] as String;
            } else if (data['token'] != null) {
              accumulatedResponse += data['token'] as String;
            }
          } catch (e) {
            // Ignore parse errors for buffer
          }
        }

        // Use final response if available, otherwise use accumulated
        if (mounted && finalResponse != null) {
          setState(() {
            pair.response = finalResponse;
            pair.isLoading = false;
            pair.dotsController?.stop();
          });
          // Scroll to bottom when response is complete, only if auto-scroll is enabled
          if (_autoScrollEnabled) {
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (_scrollController.hasClients) {
                final maxScroll = _scrollController.position.maxScrollExtent;
                if (maxScroll > 0) {
                  _scrollController.animateTo(
                    maxScroll,
                    duration: const Duration(milliseconds: 300),
                    curve: Curves.easeOut,
                  );
                }
              }
            });
          }
        } else if (mounted &&
            accumulatedResponse.isNotEmpty &&
            pair.response == null) {
          setState(() {
            pair.response = accumulatedResponse;
            pair.isLoading = false;
            pair.dotsController?.stop();
          });
          // Scroll to bottom when response is complete, only if auto-scroll is enabled
          if (_autoScrollEnabled) {
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (_scrollController.hasClients) {
                final maxScroll = _scrollController.position.maxScrollExtent;
                if (maxScroll > 0) {
                  _scrollController.animateTo(
                    maxScroll,
                    duration: const Duration(milliseconds: 300),
                    curve: Curves.easeOut,
                  );
                }
              }
            });
          }
        }

        client.close();
      } else {
        if (mounted) {
          setState(() {
            pair.error = 'Error: ${streamedResponse.statusCode}';
            pair.isLoading = false;
            pair.dotsController?.stop();
          });
        }
        client.close();
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          pair.error = 'Failed to connect: $e';
          pair.isLoading = false;
          pair.dotsController?.stop();
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Theme(
      data: Theme.of(context).copyWith(
        scrollbarTheme: ScrollbarThemeData(
          thickness: WidgetStateProperty.all(0.0),
          thumbVisibility: WidgetStateProperty.all(false),
        ),
      ),
      child: Scaffold(
        backgroundColor: AppTheme.backgroundColor,
        body: SafeArea(
          bottom: false,
          child: ValueListenableBuilder<bool>(
            valueListenable: GlobalLogoBar.fullscreenNotifier,
            builder: (context, isFullscreen, child) {
              return Padding(
                padding: EdgeInsets.only(
                    bottom: _getAdaptiveBottomPadding(),
                    top: GlobalLogoBar.getContentTopPadding()),
                child: Center(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 600),
                    child: SizedBox(
                      width: double.infinity,
                      height: double.infinity,
                      //padding: const EdgeInsets.all(15),
                      child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Expanded(
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Expanded(
                              child: SingleChildScrollView(
                                controller: _scrollController,
                                reverse: false,
                                physics: const AlwaysScrollableScrollPhysics(),
                                child: Padding(
                                  padding: const EdgeInsets.only(
                                      left: 20.0, right: 20.0),
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    mainAxisAlignment: MainAxisAlignment.start,
                                    children:
                                        _qaPairs.asMap().entries.map((entry) {
                                      final index = entry.key;
                                      final pair = entry.value;
                                      return Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: [
                                          // Question
                                          Text(
                                            pair.question,
                                            style: const TextStyle(
                                              fontFamily: 'Aeroport',
                                              fontSize: 20,
                                              fontWeight: FontWeight.w400,
                                              color: Color.fromARGB(
                                                  255, 255, 255, 255),
                                            ),
                                            textAlign: TextAlign.left,
                                          ),
                                          const SizedBox(height: 16),
                                          // Response (loading, error, or content)
                                          if (pair.isLoading &&
                                              pair.dotsController != null)
                                            AnimatedBuilder(
                                              animation: pair.dotsController!,
                                              builder: (context, child) {
                                                final progress =
                                                    pair.dotsController!.value;
                                                int dotCount = 1;
                                                if (progress < 0.33) {
                                                  dotCount = 1;
                                                } else if (progress < 0.66) {
                                                  dotCount = 2;
                                                } else {
                                                  dotCount = 3;
                                                }
                                                return Text(
                                                  '·' * dotCount,
                                                  style: const TextStyle(
                                                    fontFamily: 'Aeroport',
                                                    fontSize: 15,
                                                    fontWeight: FontWeight.w400,
                                                    color: Color.fromARGB(
                                                        255, 255, 255, 255),
                                                  ),
                                                  textAlign: TextAlign.left,
                                                );
                                              },
                                            )
                                          else if (pair.error != null)
                                            Text(
                                              pair.error!,
                                              style: const TextStyle(
                                                fontFamily: 'Aeroport',
                                                fontSize: 15,
                                                fontWeight: FontWeight.w400,
                                                color: Colors.red,
                                              ),
                                              textAlign: TextAlign.left,
                                            )
                                          else if (pair.response != null)
                                            Text(
                                              pair.response!,
                                              style: const TextStyle(
                                                fontFamily: 'Aeroport',
                                                fontSize: 15,
                                                fontWeight: FontWeight.w400,
                                                color: Color(0xFFFFFFFF),
                                              ),
                                              textAlign: TextAlign.left,
                                            )
                                          else
                                            const Text(
                                              'No response received',
                                              style: TextStyle(
                                                fontFamily: 'Aeroport',
                                                fontSize: 15,
                                                fontWeight: FontWeight.w400,
                                                color: Color(0xFFFFFFFF),
                                              ),
                                            ),
                                          // Add spacing between Q&A pairs (except for the last one in reversed list)
                                          if (index < _qaPairs.length - 1)
                                            const SizedBox(height: 32),
                                        ],
                                      );
                                    }).toList(),
                                  ),
                                ),
                              ),
                            ),
                            // Custom scrollbar - always visible on mobile
                            // Position it as a separate row item to ensure it's always in viewport
                            SizedBox(
                              width: 1.0,
                              child: LayoutBuilder(
                                builder: (context, constraints) {
                                  // Check for valid constraints and scroll controller
                                  if (!_scrollController.hasClients ||
                                      constraints.maxHeight ==
                                          double.infinity ||
                                      constraints.maxHeight <= 0) {
                                    return const SizedBox.shrink();
                                  }

                                  try {
                                    final maxScroll = _scrollController
                                        .position.maxScrollExtent;
                                    if (maxScroll <= 0) {
                                      return const SizedBox.shrink();
                                    }

                                    final containerHeight =
                                        constraints.maxHeight;
                                    final indicatorHeight = (containerHeight *
                                            _scrollIndicatorHeight)
                                        .clamp(0.0, containerHeight);
                                    final availableSpace =
                                        (containerHeight - indicatorHeight)
                                            .clamp(0.0, containerHeight);
                                    final topPosition =
                                        (_scrollProgress * availableSpace)
                                            .clamp(0.0, containerHeight);

                                    // Only show white thumb, no grey track background
                                    return Align(
                                      alignment: Alignment.topCenter,
                                      child: Padding(
                                        padding:
                                            EdgeInsets.only(top: topPosition),
                                        child: Container(
                                          width: 1.0,
                                          height: indicatorHeight.clamp(
                                              0.0, containerHeight),
                                          color: const Color(0xFFFFFFFF),
                                        ),
                                      ),
                                    );
                                  } catch (e) {
                                    // Return empty widget if any error occurs
                                    return const SizedBox.shrink();
                                  }
                                },
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
              );
            },
          ),
        ),
      ),
    );
  }
}

class TradePage extends StatefulWidget {
  const TradePage({super.key});

  @override
  State<TradePage> createState() => _TradePageState();
}

class _TradePageState extends State<TradePage> with TickerProviderStateMixin {
  void _handleBackButton() {
    Navigator.of(context).pop();
  }
  
  StreamSubscription<tma.BackButton>? _backButtonSubscription;

  // Helper method to calculate adaptive bottom padding
  double _getAdaptiveBottomPadding() {
    final service = TelegramSafeAreaService();
    final safeAreaInset = service.getSafeAreaInset();

    // Formula: bottom SafeAreaInset + 30px
    final bottomPadding = safeAreaInset.bottom + 30;
    return bottomPadding;
  }

  late final AnimationController _bgController;
  late final Animation<double> _bgAnimation;
  late final double _bgSeed;
  late final AnimationController _noiseController;
  late final Animation<double> _noiseAnimation;

  @override
  void initState() {
    super.initState();
    
    // Initialize background animations (same as main page)
    final random = math.Random();
    final durationMs = 20000 + random.nextInt(14000);
    _bgController = AnimationController(
      vsync: this,
      duration: Duration(milliseconds: durationMs),
    )..repeat(reverse: true);
    _bgAnimation =
        CurvedAnimation(parent: _bgController, curve: Curves.easeInOut);
    _bgSeed = random.nextDouble();
    _noiseController = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 24),
    )..repeat(reverse: true);
    _noiseAnimation =
        Tween<double>(begin: -0.2, end: 0.2).animate(CurvedAnimation(
      parent: _noiseController,
      curve: Curves.easeInOut,
    ));
    
    // Set up back button using flutter_telegram_miniapp package
    WidgetsBinding.instance.addPostFrameCallback((_) {
      try {
        final webApp = tma.WebApp();
        final eventHandler = webApp.eventHandler;
        
        // Listen to backButtonClicked event
        _backButtonSubscription = eventHandler.backButtonClicked.listen((backButton) {
          _handleBackButton();
        });
        
        // Show the back button
        Future.delayed(const Duration(milliseconds: 200), () {
          try {
            webApp.backButton.show();
          } catch (e) {
            // Ignore errors
          }
        });
      } catch (e) {
        // Ignore errors
      }
    });
  }

  @override
  void dispose() {
    _backButtonSubscription?.cancel();
    _bgController.dispose();
    _noiseController.dispose();
    
    // Hide back button when leaving swap page
    try {
      tma.WebApp().backButton.hide();
    } catch (e) {
      // Ignore errors
    }
    
    super.dispose();
  }

  Color _shiftColor(Color base, double shift) {
    final hsl = HSLColor.fromColor(base);
    final newLightness = (hsl.lightness + shift).clamp(0.0, 1.0);
    final newHue = (hsl.hue + shift * 10) % 360;
    final newSaturation = (hsl.saturation + shift * 0.1).clamp(0.0, 1.0);
    return hsl
        .withLightness(newLightness)
        .withHue(newHue)
        .withSaturation(newSaturation)
        .toColor();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: AnimatedBuilder(
        animation: _bgAnimation,
        builder: (context, child) {
          final baseShimmer =
              math.sin(2 * math.pi * (_bgAnimation.value + _bgSeed));
          final shimmer = 0.007 * baseShimmer;
          final baseColors = AppTheme.baseColors;
          const stopsCount = 28;
          final colors = List.generate(stopsCount, (index) {
            final progress = index / (stopsCount - 1);
            final scaled = progress * (baseColors.length - 1);
            final lowerIndex = scaled.floor();
            final upperIndex = scaled.ceil();
            final frac = scaled - lowerIndex;
            final lower =
                baseColors[lowerIndex.clamp(0, baseColors.length - 1)];
            final upper =
                baseColors[upperIndex.clamp(0, baseColors.length - 1)];
            final blended = Color.lerp(lower, upper, frac)!;
            final offset = index * 0.0015;
            return _shiftColor(blended, shimmer * (0.035 + offset));
          });
          final stops = List.generate(
              colors.length, (index) => index / (colors.length - 1));
          final rotation =
              math.sin(2 * math.pi * (_bgAnimation.value + _bgSeed)) * 0.35;
          final begin = Alignment(-0.8 + rotation, -0.7 - rotation * 0.2);
          final end = Alignment(0.9 - rotation, 0.8 + rotation * 0.2);
          return Stack(
            fit: StackFit.expand,
            children: [
              Container(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: begin,
                    end: end,
                    colors: colors,
                    stops: stops,
                  ),
                ),
              ),
              AnimatedBuilder(
                animation: _noiseAnimation,
                builder: (context, _) {
                  final alignment = Alignment(
                    0.2 + _noiseAnimation.value,
                    -0.4 + _noiseAnimation.value * 0.5,
                  );
                  return Container(
                    decoration: BoxDecoration(
                      gradient: RadialGradient(
                        center: alignment,
                        radius: 0.75,
                        colors: [
                          Colors.white.withOpacity(0.01),
                          Colors.transparent,
                        ],
                        stops: const [0.0, 1.0],
                      ),
                    ),
                  );
                },
              ),
              Container(
                decoration: BoxDecoration(
                  gradient: RadialGradient(
                    center: const Alignment(0.7, -0.6),
                    radius: 0.8,
                    colors: [
                      _shiftColor(AppTheme.radialGradientColor, shimmer * 0.4),
                      Colors.transparent,
                    ],
                    stops: const [0.0, 1.0],
                  ),
                  color: AppTheme.overlayColor.withOpacity(0.02),
                ),
              ),
              IgnorePointer(
                child: Container(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      colors: [
                        Colors.white.withOpacity(0.01),
                        Colors.transparent,
                        Colors.white.withOpacity(0.005),
                      ],
                      stops: const [0.0, 0.5, 1.0],
                    ),
                  ),
                ),
              ),
              child!,
            ],
          );
        },
        child: SafeArea(
          bottom: false,
          child: ValueListenableBuilder<bool>(
            valueListenable: GlobalLogoBar.fullscreenNotifier,
            builder: (context, isFullscreen, child) {
              return Padding(
                padding: EdgeInsets.only(
                    bottom: _getAdaptiveBottomPadding(),
                    top: GlobalLogoBar.getContentTopPadding()),
                child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 600),
                child: Container(
                  width: double.infinity,
                  padding: const EdgeInsets.only(
                    top: 30,
                    bottom: 15,
                    left: 15,
                    right: 15,
                  ),
                  child: Center(
                    child: SvgPicture.asset(
                      AppTheme.isLightTheme
                          ? 'assets/images/404_light.svg'
                          : 'assets/images/404_dark.svg',
                      width: 32,
                      height: 32,
                    ),
                  ),
                ),
              ),
            ),
              );
            },
          ),
        ),
      ),
    );
  }
}
