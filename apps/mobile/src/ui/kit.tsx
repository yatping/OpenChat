import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, useColorScheme, View, type TextInputProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

/**
 * The OpenChat theme, from its icon: electric blue, navy, and a lavender-white. The same values are in
 * docs/architecture/design-system.md, and in the dashboard and the widget.
 */
const palettes = {
  light: { background: '#ffffff', surface: '#f5f7fc', raised: '#ffffff', soft: '#eef4ff', text: '#0b1437', muted: '#4d5a80', border: '#dee4f0', primary: '#0a57f5', onPrimary: '#ffffff', accent: '#18a0fb', danger: '#b42318', online: '#12b76a' },
  dark: { background: '#0a1233', surface: '#0f1a45', raised: '#1e2a55', soft: '#1e2a55', text: '#eef2ff', muted: '#a3aed0', border: '#26315f', primary: '#5b9bff', onPrimary: '#0a1233', accent: '#18a0fb', danger: '#fda29b', online: '#32d583' },
};

export type Theme = (typeof palettes)['light'];

export const useTheme = (): Theme => palettes[useColorScheme() === 'dark' ? 'dark' : 'light'];

/** For React Navigation, so that headers and backgrounds match the rest of the app. */
export function navigationTheme<T extends { dark: boolean; colors: Record<string, string> }>(base: T, theme: Theme): T {
  return { ...base, colors: { ...base.colors, primary: theme.primary, background: theme.surface, card: theme.background, text: theme.text, border: theme.border, notification: theme.primary } };
}

/** Up to two initials, or nothing for someone with no name. */
export function initials(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const first = [...words[0]!][0] ?? '';
  const last = words.length > 1 ? ([...words[words.length - 1]!][0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** Initials in a blue circle, with a green dot when the person is online. Decorative: the row says who it is. */
export function Avatar({ name, size = 44, online }: { name: string | null | undefined; size?: number; online?: boolean }) {
  const theme = useTheme();
  const letters = initials(name);
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}>
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: letters ? theme.primary : theme.soft, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: letters ? '#ffffff' : theme.primary, fontWeight: '700', fontSize: size * (letters ? 0.36 : 0.45) }}>{letters || '?'}</Text>
      </View>
      {online && <View style={[styles.presence, { backgroundColor: theme.online, borderColor: theme.background }]} />}
    </View>
  );
}

export function Screen({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.surface }}>
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
      <TextInput accessibilityLabel={label} placeholderTextColor={theme.muted} autoCapitalize="none" autoCorrect={false} style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.raised }]} {...input} />
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
  input: { fontSize: 16, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, minHeight: 50 },
  button: { minHeight: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  buttonText: { fontSize: 16, fontWeight: '600' },
  presence: { position: 'absolute', right: 0, bottom: 0, width: 13, height: 13, borderRadius: 7, borderWidth: 2 },
});
