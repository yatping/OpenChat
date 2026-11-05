import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, useColorScheme, View, type TextInputProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const palettes = {
  light: { background: '#ffffff', surface: '#f3f4f6', text: '#111827', muted: '#4b5563', border: '#d1d5db', primary: '#1d4ed8', onPrimary: '#ffffff', danger: '#b91c1c' },
  dark: { background: '#0b0f17', surface: '#1a2130', text: '#f3f4f6', muted: '#a3acbb', border: '#3a4557', primary: '#60a5fa', onPrimary: '#0b0f17', danger: '#fca5a5' },
};

export const useTheme = () => palettes[useColorScheme() === 'dark' ? 'dark' : 'light'];

export function Screen({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.background }}>
      <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function Title({ children }: { children: ReactNode }) {
  return <Text accessibilityRole="header" style={[styles.title, { color: useTheme().text }]}>{children}</Text>;
}

export function Body({ children, muted }: { children: ReactNode; muted?: boolean }) {
  const theme = useTheme();
  return <Text style={[styles.body, { color: muted ? theme.muted : theme.text }]}>{children}</Text>;
}

export function Problem({ children }: { children: ReactNode }) {
  return <Text accessibilityRole="alert" style={[styles.body, { color: useTheme().danger }]}>{children}</Text>;
}

export function Field({ label, ...input }: { label: string } & TextInputProps) {
  const theme = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
      <TextInput accessibilityLabel={label} placeholderTextColor={theme.muted} autoCapitalize="none" autoCorrect={false} style={[styles.input, { color: theme.text, borderColor: theme.border }]} {...input} />
    </View>
  );
}

export function Button({ title, onPress, busy, kind = 'primary', disabled }: { title: string; onPress: () => void; busy?: boolean; kind?: 'primary' | 'plain' | 'danger'; disabled?: boolean }) {
  const theme = useTheme();
  const off = busy === true || disabled === true;
  const color = kind === 'primary' ? theme.onPrimary : kind === 'danger' ? theme.danger : theme.primary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: off, busy: busy === true }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [styles.button, kind === 'primary' ? { backgroundColor: theme.primary } : { borderColor: theme.border, borderWidth: StyleSheet.hairlineWidth }, { opacity: off ? 0.6 : pressed ? 0.8 : 1 }]}
    >
      {busy ? <ActivityIndicator color={color} /> : <Text style={[styles.buttonText, { color }]}>{title}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 14, flexGrow: 1 },
  title: { fontSize: 28, fontWeight: '700' },
  body: { fontSize: 16, lineHeight: 22 },
  field: { gap: 6 },
  label: { fontSize: 15, fontWeight: '600' },
  input: { fontSize: 16, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, minHeight: 48 },
  button: { minHeight: 48, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  buttonText: { fontSize: 16, fontWeight: '600' },
});
