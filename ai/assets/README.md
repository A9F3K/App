# Assets Directory

This directory is for static assets that are used in your Flutter code.

## Structure

```
assets/
  ├── images/     # Images (logos, photos, etc.)
  ├── icons/      # Icons
  └── fonts/      # Custom fonts (if needed)
```

## Usage in Code

To use assets in your Flutter code:

```dart
Image.asset('assets/images/logo.png')
```

## Don't forget!

Add the assets to `pubspec.yaml`:

```yaml
flutter:
  assets:
    - assets/images/
    - assets/icons/
```


