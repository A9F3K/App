import React, { Component, type ReactNode } from "react";
import { Text, View } from "react-native";

type Props = {
  children: ReactNode;
  resetKey?: string | number | null;
  fallbackLabel?: string;
};

type State = { hasError: boolean };

/** Keeps a messages subtree failure from blanking the whole home screen. */
export class MessageSubtreeErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidUpdate(prevProps: Props): void {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <Text style={{ textAlign: "center", opacity: 0.75 }}>
            {this.props.fallbackLabel ??
              "Something went wrong loading this chat. Switch chats or reload the page."}
          </Text>
        </View>
      );
    }
    return this.props.children;
  }
}
