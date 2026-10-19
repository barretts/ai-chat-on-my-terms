import { useState } from "react";
import { Linking, View } from "react-native";
import { Button, Text } from "react-native-paper";

export function PublicSupportLinks() {
  const [error, setError] = useState("");
  const open = async (path: string) => {
    setError("");
    try {
      await Linking.openURL(`https://aichat.sosuke.com/${path}/`);
    } catch {
      setError(
        "Could not open the website. For help, email barrett@sosuke.com.",
      );
    }
  };
  return (
    <View>
      <Button onPress={() => void open("privacy")}>Privacy policy</Button>
      <Button onPress={() => void open("support")}>Contact support</Button>
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
    </View>
  );
}
