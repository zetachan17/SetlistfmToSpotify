chrome.runtime.onInstalled.addListener(() => {
  // Request notification permission
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon48.png', // Make sure to add this icon to your extension
    title: 'Setlist to Spotify',
    message: 'Extension installed successfully!'
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CREATE_PLAYLIST') {
    createSpotifyPlaylist(message.data)
      .catch(error => {
        console.error('Playlist creation error:', error);
        chrome.runtime.sendMessage({
          type: 'ERROR',
          error: error.message
        });
      });
  }
});

// Add this helper function for string similarity
function similarity(s1, s2) {
  s1 = s1.toLowerCase();
  s2 = s2.toLowerCase();
  
  // Remove special characters and extra spaces
  s1 = s1.replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
  s2 = s2.replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
  
  if (s1 === s2) return 1.0;
  if (s1.includes(s2) || s2.includes(s1)) return 0.9;
  
  const pairs1 = new Set();
  const pairs2 = new Set();
  
  for (let i = 0; i < s1.length - 1; i++) {
    pairs1.add(s1.slice(i, i + 2));
  }
  for (let i = 0; i < s2.length - 1; i++) {
    pairs2.add(s2.slice(i, i + 2));
  }
  
  const intersection = new Set([...pairs1].filter(x => pairs2.has(x)));
  return (2.0 * intersection.size) / (pairs1.size + pairs2.size);
}

async function createSpotifyPlaylist({ songs, artist, eventDate, venue, city }) {
  try {
    const token = await chrome.storage.local.get('spotifyToken');
    if (!token.spotifyToken) {
      throw new Error('Not logged in to Spotify');
    }

    // Track different types of song additions
    const addedTracks = [];
    const addedWithDifferentArtist = [];
    const missingTracks = [];

    // Get user ID
    const userResponse = await fetch('https://api.spotify.com/v1/me', {
      headers: {
        'Authorization': `Bearer ${token.spotifyToken}`
      }
    });
    const userData = await userResponse.json();

    // Create playlist with venue information
    const playlistResponse = await fetch(`https://api.spotify.com/v1/users/${userData.id}/playlists`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token.spotifyToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: `${artist} - ${city} - ${eventDate}`,
        description: `Live at ${venue}. Created from setlist.fm using Setlist to Spotify extension`
      })
    });
    const playlistData = await playlistResponse.json();

    // Send initial progress
    chrome.runtime.sendMessage({
      type: 'PROGRESS_UPDATE',
      data: {
        currentSong: '',
        processed: 0,
        total: songs.length,
        added: 0
      }
    });

    // Process songs one by one
    for (let i = 0; i < songs.length; i++) {
      const song = songs[i];
      const isPartOfMedley = songs[i-1] && songs[i-1].includes('/');
      
      // Update progress with context for medley songs
      chrome.runtime.sendMessage({
        type: 'PROGRESS_UPDATE',
        data: {
          currentSong: isPartOfMedley ? `${song} (Part of medley)` : song,
          processed: i,
          total: songs.length,
          added: addedTracks.length + addedWithDifferentArtist.length
        }
      });

      // First try: search with artist name
      let searchResponse = await fetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(`track:${song} artist:${artist}`)}&type=track&limit=1`,
        {
          headers: {
            'Authorization': `Bearer ${token.spotifyToken}`
          }
        }
      );
      let searchData = await searchResponse.json();
      
      if (searchData.tracks.items.length > 0) {
        // Song found with original artist
        await addTrackToPlaylist(playlistData.id, searchData.tracks.items[0].uri, token.spotifyToken);
        addedTracks.push(song);
        chrome.runtime.sendMessage({
          type: 'PROGRESS_UPDATE',
          data: {
            currentSong: song,
            processed: i + 1,
            total: songs.length,
            added: addedTracks.length + addedWithDifferentArtist.length
          }
        });
      } else {
        // Second try: search without artist name
        searchResponse = await fetch(
          `https://api.spotify.com/v1/search?q=${encodeURIComponent(song)}&type=track&limit=3`,
          {
            headers: {
              'Authorization': `Bearer ${token.spotifyToken}`
            }
          }
        );
        searchData = await searchResponse.json();

        if (searchData.tracks.items.length > 0) {
          // Create a promise that will resolve when the user makes a selection
          const userSelection = await new Promise((resolve) => {
            let selectionHandler;
            
            // Create the message listener
            selectionHandler = function(message) {
              if (message.type === 'SONG_SELECTED' || message.type === 'SONG_SKIPPED') {
                // Remove the listener to avoid memory leaks
                chrome.runtime.onMessage.removeListener(selectionHandler);
                
                // Resolve with the selection data or null if skipped
                resolve(message.type === 'SONG_SELECTED' ? message.data : null);
              }
            };

            // Add the listener
            chrome.runtime.onMessage.addListener(selectionHandler);

            // Send options to popup
            chrome.runtime.sendMessage({
              type: 'SONG_SELECTION',
              data: {
                originalSong: song,
                options: searchData.tracks.items.map(track => ({
                  uri: track.uri,
                  name: track.name,
                  artist: track.artists[0].name,
                  album: track.album.name,
                  albumImage: track.album.images[1]?.url || track.album.images[0]?.url,
                })).slice(0, 3),
                searchQuery: song
              }
            });
          });

          if (userSelection) {
            // User selected a track
            await addTrackToPlaylist(playlistData.id, userSelection.uri, token.spotifyToken);
            addedWithDifferentArtist.push({
              originalSong: song,
              foundTrack: {
                name: userSelection.name,
                artist: userSelection.artist
              }
            });
            chrome.runtime.sendMessage({
              type: 'PROGRESS_UPDATE',
              data: {
                currentSong: song,
                processed: i + 1,
                total: songs.length,
                added: addedTracks.length + addedWithDifferentArtist.length
              }
            });
          } else {
            // User skipped this song
            missingTracks.push(song);
          }
        } else {
          missingTracks.push(song);
        }
      }
    }

    // Final progress update
    chrome.runtime.sendMessage({
      type: 'PROGRESS_UPDATE',
      data: {
        currentSong: 'Complete!',
        processed: songs.length,
        total: songs.length,
        added: addedTracks.length + addedWithDifferentArtist.length
      }
    });

    // Playlist creation completed
    const notificationMessage = `Playlist created with ${addedTracks.length + addedWithDifferentArtist.length}/${songs.length} songs`;
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icon48.png',
      title: 'Playlist Created!',
      message: notificationMessage,
      buttons: [{ title: 'Open Playlist' }]
    });

    // Store playlist URL and send success message
    await chrome.storage.local.set({ lastPlaylistUrl: playlistData.external_urls.spotify });
    chrome.runtime.sendMessage({
      type: 'SUCCESS',
      data: {
        message: `Created playlist: ${artist} - ${city} - ${eventDate}`,
        playlistUrl: playlistData.external_urls.spotify,
        venue: venue,
        totalSongs: songs.length,
        addedSongs: addedTracks,
        addedWithDifferentArtist: addedWithDifferentArtist,
        missingSongs: missingTracks,
        hasMedleys: songs.some(song => song.includes('/'))
      }
    });
  } catch (error) {
    console.error('Error creating playlist:', error);
    chrome.runtime.sendMessage({
      type: 'ERROR',
      error: error.message
    });
  }
}

// Helper function to add track to playlist
async function addTrackToPlaylist(playlistId, trackUri, token) {
  await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      uris: [trackUri]
    })
  });
}

// Add notification click handler
chrome.notifications.onButtonClicked.addListener((notificationId) => {
  chrome.storage.local.get('lastPlaylistUrl', (data) => {
    if (data.lastPlaylistUrl) {
      chrome.tabs.create({ url: data.lastPlaylistUrl });
    }
  });
}); 