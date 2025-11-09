import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';

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
        scaffoldBackgroundColor: Colors.black,
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
      backgroundColor: Colors.black,
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 600),
          child: SizedBox(
            width: double.infinity,
            height: double.infinity,
            // padding: const EdgeInsets.all(15),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.center,
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(15),
                  decoration: const BoxDecoration(
                    color: Colors.black,
                  ),
                  child: SvgPicture.asset(
                    'assets/images/logo.svg',
                    width: 30,
                    height: 30,
                  ),
                ),
                // Add your second child here
                if (!_isFocused) ...[
                  const SizedBox(
                    width: 100,
                    height: 50,
                    child: Center(
                      child: Text('Child 1',
                          style: TextStyle(color: Colors.white)),
                    ),
                  ),
                  const SizedBox(
                    width: 100,
                    height: 50,
                    child: Center(
                      child: Text('Child 2',
                          style: TextStyle(color: Colors.white)),
                    ),
                  ),
                  const SizedBox(
                    width: 100,
                    height: 50,
                    child: Center(
                      child: Text('Child 3',
                          style: TextStyle(color: Colors.white)),
                    ),
                  ),
                  const SizedBox(
                    width: 100,
                    height: 50,
                    child: Center(
                      child: Text('Child 4',
                          style: TextStyle(color: Colors.white)),
                    ),
                  ),
                ],
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(15),
                  decoration: const BoxDecoration(
                    color: Colors.black,
                  ),
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
                                    cursorColor: Colors.white,
                                    cursorHeight: 15,
                                    maxLines: 11,
                                    minLines: 1,
                                    textAlignVertical: TextAlignVertical.center,
                                    style: const TextStyle(
                                        fontFamily: 'Aeroport',
                                        fontSize: 15,
                                        fontWeight: FontWeight.w500,
                                        height: 2.0,
                                        color: Colors.white),
                                    onSubmitted: (value) {
                                      _navigateToNewPage();
                                    },
                                    decoration: InputDecoration(
                                      hintText: (_isFocused ||
                                              _controller.text.isNotEmpty)
                                          ? null
                                          : 'Ask anything',
                                      hintStyle: const TextStyle(
                                          color: Colors.white,
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
                                    cursorColor: Colors.white,
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
                                        height: 2,
                                        color: Colors.white),
                                    onSubmitted: (value) {
                                      _navigateToNewPage();
                                    },
                                    decoration: InputDecoration(
                                      hintText: (_isFocused ||
                                              _controller.text.isNotEmpty)
                                          ? null
                                          : 'Ask anything',
                                      hintStyle: const TextStyle(
                                          color: Colors.white,
                                          fontFamily: 'Aeroport',
                                          fontSize: 15,
                                          fontWeight: FontWeight.w500,
                                          height: 2),
                                      border: InputBorder.none,
                                      enabledBorder: InputBorder.none,
                                      focusedBorder: InputBorder.none,
                                      isDense: true,
                                      contentPadding:
                                          _controller.text.split('\n').length >
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
                ),
              ],
            ),
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
  // List to store all Q&A pairs
  final List<QAPair> _qaPairs = [];
  final String _apiUrl = 'https://xp7k-production.up.railway.app';
  late AnimationController _dotsController;

  // Input field controllers
  final TextEditingController _inputController = TextEditingController();
  final FocusNode _inputFocusNode = FocusNode();
  final GlobalKey _inputTextFieldKey = GlobalKey();
  bool _isInputFocused = false;

  // Scroll controller for auto-scrolling to new responses
  final ScrollController _scrollController = ScrollController();

  // Track if auto-scrolling is enabled (disabled when user manually scrolls)
  bool _autoScrollEnabled = true;

  @override
  void initState() {
    super.initState();
    _dotsController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1200),
    )..repeat();
    _inputFocusNode.addListener(() {
      setState(() {
        _isInputFocused = _inputFocusNode.hasFocus;
      });
    });

    // Listen to scroll changes to detect manual scrolling
    _scrollController.addListener(() {
      if (_scrollController.hasClients) {
        final maxScroll = _scrollController.position.maxScrollExtent;
        final currentScroll = _scrollController.position.pixels;
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

    _inputController.addListener(() {
      // Check if text contains newline (Enter was pressed)
      if (_inputController.text.contains('\n')) {
        final textWithoutNewline = _inputController.text.replaceAll('\n', '');
        _inputController.value = TextEditingValue(
          text: textWithoutNewline,
          selection: TextSelection.collapsed(offset: textWithoutNewline.length),
        );
        WidgetsBinding.instance.addPostFrameCallback((_) {
          _askNewQuestion();
        });
      }
      setState(() {});
    });
    // Add initial Q&A pair with the title
    _qaPairs.add(QAPair(
      question: widget.title,
      isLoading: true,
      dotsController: _dotsController,
    ));
    _fetchAIResponse(_qaPairs.last);
  }

  @override
  void dispose() {
    _dotsController.dispose();
    _inputController.dispose();
    _inputFocusNode.dispose();
    _scrollController.dispose();
    // Dispose all animation controllers
    for (var pair in _qaPairs) {
      pair.dotsController?.dispose();
    }
    super.dispose();
  }

  void _askNewQuestion() {
    final text = _inputController.text.trim();
    if (text.isNotEmpty) {
      // Clear input
      _inputController.clear();

      // Create new animation controller for this Q&A pair
      final newDotsController = AnimationController(
        vsync: this,
        duration: const Duration(milliseconds: 1200),
      )..repeat();

      // Add new Q&A pair at the end (bottom of the list)
      final newPair = QAPair(
        question: text,
        isLoading: true,
        dotsController: newDotsController,
      );
      setState(() {
        _qaPairs.add(newPair);
      });

      // Fetch AI response for the new question
      _fetchAIResponse(newPair);

      // Scroll to bottom after a short delay, only if auto-scroll is enabled
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
  }

  Future<void> _fetchAIResponse(QAPair pair) async {
    try {
      final request = http.Request(
        'POST',
        Uri.parse('$_apiUrl/api/chat'),
      );
      request.headers['Content-Type'] = 'application/json';
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
          thickness: WidgetStateProperty.all(1.0),
          radius: const Radius.circular(0),
          thumbVisibility: WidgetStateProperty.all(true),
          thumbColor: WidgetStateProperty.all(Colors.white),
          trackColor: WidgetStateProperty.all(Colors.white.withOpacity(0.2)),
          minThumbLength: 20.0,
        ),
      ),
      child: Scaffold(
        backgroundColor: Colors.black,
        body: Center(
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
                  GestureDetector(
                    onTap: () {
                      Navigator.of(context).popUntil((route) => route.isFirst);
                    },
                    child: Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(15),
                      decoration: const BoxDecoration(
                        color: Colors.black,
                      ),
                      child: SvgPicture.asset(
                        'assets/images/logo.svg',
                        width: 30,
                        height: 30,
                      ),
                    ),
                  ),
                  Expanded(
                    child: Padding(
                      padding: const EdgeInsets.only(bottom: 15.0, right: 15.0),
                      child: Scrollbar(
                        controller: _scrollController,
                        thumbVisibility: true,
                        thickness: 1.0,
                        radius: const Radius.circular(0),
                        child: SingleChildScrollView(
                          controller: _scrollController,
                          reverse: false,
                          physics: const AlwaysScrollableScrollPhysics(),
                          child: Padding(
                            padding:
                                const EdgeInsets.only(left: 15.0, right: 15.0),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              mainAxisAlignment: MainAxisAlignment.start,
                              children: _qaPairs.asMap().entries.map((entry) {
                                final index = entry.key;
                                final pair = entry.value;
                                return Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    // Question
                                    Text(
                                      pair.question,
                                      style: const TextStyle(
                                        fontFamily: 'Aeroport',
                                        fontSize: 20,
                                        fontWeight: FontWeight.w700,
                                        color: Colors.white,
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
                                              fontWeight: FontWeight.w500,
                                              color: Colors.white,
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
                                          fontWeight: FontWeight.w500,
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
                                          fontWeight: FontWeight.w500,
                                          color: Colors.white,
                                        ),
                                        textAlign: TextAlign.left,
                                      )
                                    else
                                      const Text(
                                        'No response received',
                                        style: TextStyle(
                                          fontFamily: 'Aeroport',
                                          fontSize: 15,
                                          fontWeight: FontWeight.w500,
                                          color: Colors.white,
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
                    ),
                  ),
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(15),
                    decoration: const BoxDecoration(
                      color: Colors.black,
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        Expanded(
                          child: Container(
                            constraints: const BoxConstraints(minHeight: 30),
                            child: _inputController.text.isEmpty
                                ? SizedBox(
                                    height: 30,
                                    child: TextField(
                                      key: _inputTextFieldKey,
                                      controller: _inputController,
                                      focusNode: _inputFocusNode,
                                      cursorColor: Colors.white,
                                      cursorHeight: 15,
                                      maxLines: 11,
                                      minLines: 1,
                                      textAlignVertical:
                                          TextAlignVertical.center,
                                      style: const TextStyle(
                                          fontFamily: 'Aeroport',
                                          fontSize: 15,
                                          fontWeight: FontWeight.w500,
                                          height: 2.0,
                                          color: Colors.white),
                                      onSubmitted: (value) {
                                        _askNewQuestion();
                                      },
                                      decoration: InputDecoration(
                                        hintText: (_isInputFocused ||
                                                _inputController
                                                    .text.isNotEmpty)
                                            ? null
                                            : 'Ask anything',
                                        hintStyle: const TextStyle(
                                            color: Colors.white,
                                            fontFamily: 'Aeroport',
                                            fontSize: 15,
                                            fontWeight: FontWeight.w500,
                                            height: 2.0),
                                        border: InputBorder.none,
                                        enabledBorder: InputBorder.none,
                                        focusedBorder: InputBorder.none,
                                        isDense: true,
                                        contentPadding: !_isInputFocused
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
                                      key: _inputTextFieldKey,
                                      controller: _inputController,
                                      focusNode: _inputFocusNode,
                                      cursorColor: Colors.white,
                                      cursorHeight: 15,
                                      maxLines: 11,
                                      minLines: 1,
                                      textAlignVertical: _inputController.text
                                                  .split('\n')
                                                  .length ==
                                              1
                                          ? TextAlignVertical.center
                                          : TextAlignVertical.bottom,
                                      style: const TextStyle(
                                          fontFamily: 'Aeroport',
                                          fontSize: 15,
                                          fontWeight: FontWeight.w500,
                                          height: 2,
                                          color: Colors.white),
                                      onSubmitted: (value) {
                                        _askNewQuestion();
                                      },
                                      decoration: InputDecoration(
                                        hintText: (_isInputFocused ||
                                                _inputController
                                                    .text.isNotEmpty)
                                            ? null
                                            : 'Ask anything',
                                        hintStyle: const TextStyle(
                                            color: Colors.white,
                                            fontFamily: 'Aeroport',
                                            fontSize: 15,
                                            fontWeight: FontWeight.w500,
                                            height: 2),
                                        border: InputBorder.none,
                                        enabledBorder: InputBorder.none,
                                        focusedBorder: InputBorder.none,
                                        isDense: true,
                                        contentPadding: _inputController.text
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
                        GestureDetector(
                          onTap: () {
                            _askNewQuestion();
                          },
                          child: SvgPicture.asset(
                            'assets/icons/apply.svg',
                            width: 30,
                            height: 30,
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
      ),
    );
  }
}
