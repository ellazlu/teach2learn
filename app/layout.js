import './globals.css';

export const metadata = {
  title: 'teach2learn',
  description: 'Learn it by teaching it.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
