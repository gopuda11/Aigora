// Centralized avatar URL builder and style definitions
// All DiceBear avatar URLs should be constructed through this module.

export var AVATAR_STYLES = [
  { id: 'thumbs', name: 'Thumbs' },
  { id: 'bottts', name: 'Bots' },
  { id: 'pixel-art', name: 'Pixel' },
  { id: 'adventurer', name: 'Adventurer' },
  { id: 'micah', name: 'Micah' },
  { id: 'fun-emoji', name: 'Emoji' },
  { id: 'icons', name: 'Icons' },
];

// Build a DiceBear avatar URL from style, seed, and optional size.
export function avatarUrl(style, seed, size) {
  var s = encodeURIComponent(seed || 'anonymous');
  return 'https://api.dicebear.com/9.x/' + (style || 'thumbs') + '/svg?seed=' + s + '&size=' + (size || 64);
}

// Build avatar URL for a user object, preferring custom avatar if set.
export function userAvatarUrl(user, size) {
  if (user && user.avatarCustom) return user.avatarCustom;
  var style = (user && user.avatarStyle) || 'thumbs';
  var seed = (user && (user.avatarSeed || user.username || user.id)) || 'anonymous';
  return avatarUrl(style, seed, size);
}

// Build avatar URL for a mate object, preferring custom avatar if set.
export function mateAvatarUrl(mate, size) {
  if (!mate) return avatarUrl('bottts', 'mate', size);
  var p = mate.profile || mate;
  if (p.avatarCustom || mate.avatarCustom) return p.avatarCustom || mate.avatarCustom;
  var style = p.avatarStyle || mate.avatarStyle || 'bottts';
  var seed = p.avatarSeed || mate.avatarSeed || mate.id || 'mate';
  return avatarUrl(style, seed, size);
}
