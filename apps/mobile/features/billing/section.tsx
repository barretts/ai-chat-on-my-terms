import { Pressable, StyleSheet, Text, View } from "react-native";
import { useBilling } from "./provider";

export function BillingSection() {
  const billing = useBilling();

  if (!billing.available)
    return (
      <View style={styles.row} testID="billing-unavailable">
        <Text style={styles.title}>Pro</Text>
        <Text style={styles.muted} testID="billing-section">
          Local-only mode: core features are free without any store.
        </Text>
      </View>
    );

  return (
    <View style={styles.row} testID="billing-section">
      <Text style={styles.title}>Pro</Text>
      <Text testID="billing-pro">
        {billing.entitlement?.pro === true
          ? billing.entitlement.source === "family"
            ? "Pro (family shared)"
            : billing.entitlement.source === "lifetime"
              ? "Pro (lifetime)"
              : "Pro (subscription)"
          : "Not active"}
      </Text>
      {billing.products.map((product) => (
        <View key={product.id} style={styles.product}>
          <Text>
            {product.title} — {product.priceLabel}
          </Text>
          {billing.canPurchase ? (
            <Pressable
              testID={`billing-purchase-${product.id}`}
              disabled={billing.busy}
              onPress={() => void billing.purchase(product.id)}
            >
              <Text>Buy</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
      <Pressable testID="billing-restore" disabled={billing.busy} onPress={() => void billing.restore()}>
        <Text>Restore purchases</Text>
      </Pressable>
      {billing.error !== null ? <Text style={styles.error}>{billing.error}</Text> : null}
      {billing.available && billing.canPurchase
        ? null
        : (
          <Text style={styles.muted}>
            Store purchases require the native store adapter (release builds).
          </Text>
        )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { gap: 8, paddingVertical: 12 },
  title: { fontWeight: "600" },
  product: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  muted: { opacity: 0.6 },
  error: { color: "#b00020" },
});
