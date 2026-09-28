import { View } from "react-native";
import { Text } from "react-native-paper";

export default function NativeInferenceInfo() {
  return (
    <View style={{ padding: 20, gap: 12 }}>
      <Text variant="headlineSmall">On-device inference</Text>
      <Text>
        GGUF and Apple ML probes require a native device. Use this browser to
        test setup, navigation, and remote chat.
      </Text>
    </View>
  );
}
