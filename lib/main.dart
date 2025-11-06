import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

void main() {
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Telegram Mini App',
      // Use default theme without Material fonts to avoid loading errors
      theme: ThemeData(
        useMaterial3: false,
        fontFamily: 'Aeroport',
        textTheme: const TextTheme(
          bodyLarge: TextStyle(
              fontFamily: 'Aeroport',
              fontSize: 15,
              fontWeight: FontWeight.w500),
          bodyMedium: TextStyle(
              fontFamily: 'Aeroport',
              fontSize: 15,
              fontWeight: FontWeight.w500),
          bodySmall: TextStyle(
              fontFamily: 'Aeroport',
              fontSize: 15,
              fontWeight: FontWeight.w500),
          displayLarge: TextStyle(
              fontFamily: 'Aeroport',
              fontSize: 15,
              fontWeight: FontWeight.w500),
          displayMedium: TextStyle(
              fontFamily: 'Aeroport',
              fontSize: 15,
              fontWeight: FontWeight.w500),
          displaySmall: TextStyle(
              fontFamily: 'Aeroport',
              fontSize: 15,
              fontWeight: FontWeight.w500),
          headlineLarge: TextStyle(
              fontFamily: 'Aeroport',
              fontSize: 15,
              fontWeight: FontWeight.w500),
          headlineMedium: TextStyle(
              fontFamily: 'Aeroport',
              fontSize: 15,
              fontWeight: FontWeight.w500),
          headlineSmall: TextStyle(
              fontFamily: 'Aeroport',
              fontSize: 15,
              fontWeight: FontWeight.w500),
          titleLarge: TextStyle(
              fontFamily: 'Aeroport',
              fontSize: 15,
              fontWeight: FontWeight.w500),
          titleMedium: TextStyle(
              fontFamily: 'Aeroport',
              fontSize: 15,
              fontWeight: FontWeight.w500),
          titleSmall: TextStyle(
              fontFamily: 'Aeroport',
              fontSize: 15,
              fontWeight: FontWeight.w500),
          labelLarge: TextStyle(
              fontFamily: 'Aeroport',
              fontSize: 15,
              fontWeight: FontWeight.w500),
          labelMedium: TextStyle(
              fontFamily: 'Aeroport',
              fontSize: 15,
              fontWeight: FontWeight.w500),
          labelSmall: TextStyle(
              fontFamily: 'Aeroport',
              fontSize: 15,
              fontWeight: FontWeight.w500),
        ),
        inputDecorationTheme: const InputDecorationTheme(
          labelStyle: TextStyle(
              fontFamily: 'Aeroport',
              fontSize: 15,
              fontWeight: FontWeight.w500),
          hintStyle: TextStyle(
              fontFamily: 'Aeroport',
              fontSize: 15,
              fontWeight: FontWeight.w500),
        ),
      ),
      debugShowCheckedModeBanner: false,
      home: const HomePage(),
    );
  }
}

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
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
      // Check if text contains newline (Enter was pressed)
      if (_controller.text.contains('\n')) {
        // Remove the newline
        final textWithoutNewline = _controller.text.replaceAll('\n', '');
        _controller.value = TextEditingValue(
          text: textWithoutNewline,
          selection: TextSelection.collapsed(offset: textWithoutNewline.length),
        );
        // Trigger navigation
        WidgetsBinding.instance.addPostFrameCallback((_) {
          _navigateToNewPage();
        });
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
      Navigator.push(
        context,
        MaterialPageRoute(
          builder: (context) => NewPage(title: text),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 480),
          child: Container(
            width: double.infinity,
            height: double.infinity,
            padding: const EdgeInsets.all(15),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.center,
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                SvgPicture.asset(
                  'assets/images/logo.svg',
                  width: 30,
                  height: 30,
                ),
                // Add your second child here
                if (!_isFocused) ...[
                  const SizedBox(
                    width: 100,
                    height: 50,
                    child: Center(
                      child: Text('Child 1'),
                    ),
                  ),
                  const SizedBox(
                    width: 100,
                    height: 50,
                    child: Center(
                      child: Text('Child 2'),
                    ),
                  ),
                  const SizedBox(
                    width: 100,
                    height: 50,
                    child: Center(
                      child: Text('Child 3'),
                    ),
                  ),
                  const SizedBox(
                    width: 100,
                    height: 50,
                    child: Center(
                      child: Text('Child 4'),
                    ),
                  ),
                ],
                Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Expanded(
                      child: Container(
                        constraints: const BoxConstraints(minHeight: 30),
                        color: Colors.white,
                        child: _controller.text.isEmpty
                            ? SizedBox(
                                height: 30,
                                child: TextField(
                                  key: _textFieldKey,
                                  controller: _controller,
                                  focusNode: _focusNode,
                                  cursorColor: Colors.black,
                                  cursorHeight: 15,
                                  maxLines: 11,
                                  minLines: 1,
                                  textAlignVertical: TextAlignVertical.center,
                                  style: const TextStyle(
                                      fontFamily: 'Aeroport',
                                      fontSize: 15,
                                      fontWeight: FontWeight.w500,
                                      height: 2.0),
                                  onSubmitted: (value) {
                                    _navigateToNewPage();
                                  },
                                  decoration: InputDecoration(
                                    hintText: (_isFocused ||
                                            _controller.text.isNotEmpty)
                                        ? null
                                        : 'Ask anything',
                                    hintStyle: const TextStyle(
                                        color: Colors.black,
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
                                  cursorColor: Colors.black,
                                  cursorHeight: 15,
                                  maxLines: 11,
                                  minLines: 1,
                                  textAlignVertical:
                                      _controller.text.split('\n').length == 1
                                          ? TextAlignVertical.center
                                          : TextAlignVertical.bottom,
                                  style: const TextStyle(
                                      fontFamily: 'Aeroport',
                                      fontSize: 15,
                                      fontWeight: FontWeight.w500,
                                      height: 2),
                                  onSubmitted: (value) {
                                    _navigateToNewPage();
                                  },
                                  decoration: InputDecoration(
                                    hintText: (_isFocused ||
                                            _controller.text.isNotEmpty)
                                        ? null
                                        : 'Ask anything',
                                    hintStyle: const TextStyle(
                                        color: Colors.black,
                                        fontFamily: 'Aeroport',
                                        fontSize: 15,
                                        fontWeight: FontWeight.w500,
                                        height: 2),
                                    border: InputBorder.none,
                                    enabledBorder: InputBorder.none,
                                    focusedBorder: InputBorder.none,
                                    isDense: true,
                                    contentPadding:
                                        _controller.text.split('\n').length > 1
                                            ? const EdgeInsets.only(
                                                left: 0, right: 0, top: 11)
                                            : const EdgeInsets.only(right: 0),
                                  ),
                                ),
                              ),
                      ),
                    ),
                    const SizedBox(width: 5),
                    GestureDetector(
                      onTap: () {
                        _navigateToNewPage();
                      },
                      child: SvgPicture.asset(
                        'assets/icons/apply.svg',
                        width: 30,
                        height: 30,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class NewPage extends StatelessWidget {
  final String title;

  const NewPage({super.key, required this.title});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 480),
          child: Container(
            width: double.infinity,
            height: double.infinity,
            padding: const EdgeInsets.all(15),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    fontFamily: 'Aeroport',
                    fontSize: 20,
                    fontWeight: FontWeight.w700,
                    color: Colors.black,
                  ),
                  textAlign: TextAlign.left,
                ),
                Text(
                  title,
                  style: const TextStyle(
                    fontFamily: 'Aeroport',
                    fontSize: 15,
                    fontWeight: FontWeight.w700,
                    color: Colors.black,
                  ),
                  textAlign: TextAlign.left,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
