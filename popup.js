const CLIENT_ID = 'YOUR_CLIENT_ID';
const REDIRECT_URI = chrome.identity.getRedirectURL();

console.log('Redirect URI:', REDIRECT_URI);

// Add this function to get user profile after login
async function updateUserProfile(token) {
  try {
    const response = await fetch('https://api.spotify.com/v1/me', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    const userData = await response.json();
    
    // Replace login button with profile info
    const loginBtn = document.getElementById('loginBtn');
    loginBtn.style.display = 'none';
    
    // Create and show profile container
    const profileContainer = document.createElement('div');
    profileContainer.className = 'profile-container';
    profileContainer.innerHTML = `
      <img src="${userData.images[0]?.url || 'default-avatar.png'}" alt="Profile" class="profile-img">
      <span class="profile-name">${userData.display_name}</span>
    `;

    // Make the container clickable and link to Spotify profile
    profileContainer.style.cursor = 'pointer';
    profileContainer.title = 'Click to open Spotify profile';
    profileContainer.addEventListener('click', () => {
      chrome.tabs.create({ url: userData.external_urls.spotify });
    });

    // Add hover effect class
    profileContainer.addEventListener('mouseenter', () => {
      profileContainer.classList.add('profile-hover');
    });
    profileContainer.addEventListener('mouseleave', () => {
      profileContainer.classList.remove('profile-hover');
    });

    loginBtn.parentNode.insertBefore(profileContainer, loginBtn);
  } catch (error) {
    console.error('Error fetching user profile:', error);
  }
}

document.getElementById('loginBtn').addEventListener('click', async () => {
  const scope = 'playlist-modify-public playlist-modify-private';
  const authUrl = new URL('https://accounts.spotify.com/authorize');
  
  // Add required parameters
  authUrl.searchParams.append('client_id', CLIENT_ID);
  authUrl.searchParams.append('response_type', 'token');
  authUrl.searchParams.append('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.append('scope', scope);
  authUrl.searchParams.append('show_dialog', 'true');

  console.log('Auth URL:', authUrl.toString()); // Debug the full auth URL

  try {
    const redirectUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl.toString(),
      interactive: true
    });
    
    if (chrome.runtime.lastError) {
      throw new Error(chrome.runtime.lastError.message);
    }

    if (redirectUrl) {
      const accessToken = new URLSearchParams(new URL(redirectUrl).hash.substr(1)).get('access_token');
      if (accessToken) {
        await chrome.storage.local.set({ spotifyToken: accessToken });
        await updateUserProfile(accessToken);
        updateStatus('Logged in successfully!');
      } else {
        throw new Error('No access token received');
      }
    }
  } catch (error) {
    console.error('Full error object:', error); // More detailed error logging
    updateStatus('Login failed: ' + error.message);
  }
});

document.getElementById('createPlaylist').addEventListener('click', async () => {
  updateStatus('Creating playlist...', true);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  if (!tab.url.includes('setlist.fm')) {
    updateStatus('Please navigate to a setlist.fm setlist page');
    return;
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: grabSetlist,
    });

    // Check for execution results
    console.log('Script execution results:', results);

    // Listen for any errors from the injected script
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'ERROR') {
        updateStatus('Error: ' + message.error, false, 'error');
      } else if (message.type === 'SUCCESS') {
        const { data } = message;
        const statusHtml = `
          <div class="success">
            <p>${data.message}</p>
            <p>Added ${data.addedSongs.length + data.addedWithDifferentArtist.length} of ${data.totalSongs} songs</p>
            <a href="${data.playlistUrl}" target="_blank" class="playlist-link">Open Playlist</a>
            
            ${data.addedWithDifferentArtist.length > 0 ? `
              <div class="different-artist-songs">
                <p>Songs added with different artists:</p>
                <ul>
                  ${data.addedWithDifferentArtist.map(item => 
                    `<li>
                      <span class="original">${item.originalSong}</span>
                      <span class="arrow">&rarr;</span>
                      <span class="found">${item.foundTrack.name}</span>
                      <span class="artist">by ${item.foundTrack.artist}</span>
                    </li>`
                  ).join('')}
                </ul>
              </div>
            ` : ''}
            
            ${data.missingSongs.length > 0 ? `
              <div class="missing-songs">
                <p>Songs not found on Spotify:</p>
                <ul>
                  ${data.missingSongs.map(song => `<li>${song}</li>`).join('')}
                </ul>
              </div>
            ` : ''}
          </div>
        `;
        updateStatus(statusHtml, false, 'success', true);
      } else if (message.type === 'SONG_SELECTION') {
        const { originalSong, options, searchQuery } = message.data;
        let currentOffset = 3; // Track how many results we've shown
        
        // Create and show the selection dialog
        const dialog = document.createElement('div');
        dialog.className = 'song-options';
        dialog.innerHTML = `
          <p>Multiple matches found for "${originalSong}". Please select the correct version:</p>
          <div class="song-options-list">
            ${options.map((option, index) => `
              <div class="song-option" data-uri="${option.uri}" data-name="${option.name}" data-artist="${option.artist}">
                <img src="${option.albumImage || 'default-album.png'}" alt="Album art" class="album-art">
                <div class="song-option-details">
                  <div class="song-option-title">${option.name}</div>
                  <div class="song-option-artist">by ${option.artist}</div>
                  <div class="song-option-album">from ${option.album}</div>
                </div>
              </div>
            `).join('')}
          </div>
          <div class="song-selection-actions">
            <button class="show-more-btn">Show More Options</button>
            <button class="skip-btn">Skip This Song</button>
          </div>
        `;

        const status = document.getElementById('status');
        status.innerHTML = '';
        status.appendChild(dialog);

        // Handle "Show More" button
        dialog.querySelector('.show-more-btn').addEventListener('click', async () => {
          try {
            const token = (await chrome.storage.local.get('spotifyToken')).spotifyToken;
            const response = await fetch(
              `https://api.spotify.com/v1/search?q=${encodeURIComponent(searchQuery)}&type=track&limit=3&offset=${currentOffset}`,
              {
                headers: {
                  'Authorization': `Bearer ${token}`
                }
              }
            );
            const data = await response.json();
            
            if (data.tracks.items.length > 0) {
              currentOffset += 3;
              const optionsList = dialog.querySelector('.song-options-list');
              
              // Add new options to the list
              data.tracks.items.forEach(track => {
                const option = document.createElement('div');
                option.className = 'song-option';
                option.dataset.uri = track.uri;
                option.dataset.name = track.name;
                option.dataset.artist = track.artists[0].name;
                option.innerHTML = `
                  <img src="${track.album.images[1]?.url || track.album.images[0]?.url || 'default-album.png'}" alt="Album art" class="album-art">
                  <div class="song-option-details">
                    <div class="song-option-title">${track.name}</div>
                    <div class="song-option-artist">by ${track.artists[0].name}</div>
                    <div class="song-option-album">from ${track.album.name}</div>
                  </div>
                `;
                optionsList.appendChild(option);
              });

              // Hide "Show More" button if no more results
              if (data.tracks.items.length < 3) {
                dialog.querySelector('.show-more-btn').style.display = 'none';
              }
            } else {
              dialog.querySelector('.show-more-btn').style.display = 'none';
            }
          } catch (error) {
            console.error('Error fetching more songs:', error);
          }
        });

        // Handle selection
        dialog.addEventListener('click', (e) => {
          const option = e.target.closest('.song-option');
          if (option) {
            dialog.querySelectorAll('.song-option').forEach(opt => opt.classList.remove('selected'));
            option.classList.add('selected');
            
            setTimeout(() => {
              // Send message to background script
              chrome.runtime.sendMessage({
                type: 'SONG_SELECTED',
                data: {
                  uri: option.dataset.uri,
                  name: option.dataset.name,
                  artist: option.dataset.artist
                }
              });

              // Clear popup state and show processing message
              chrome.storage.local.remove('popupState');
              const status = document.getElementById('status');
              status.innerHTML = '<div class="progress-container"><div class="progress-text">Processing playlist...</div></div>';
            }, 300);
          }
        });

        dialog.querySelector('.skip-btn').addEventListener('click', () => {
          // Send skip message to background script
          chrome.runtime.sendMessage({ type: 'SONG_SKIPPED' });
          
          // Clear popup state and show processing message
          chrome.storage.local.remove('popupState');
          const status = document.getElementById('status');
          status.innerHTML = '<div class="progress-container"><div class="progress-text">Processing playlist...</div></div>';
        });

        // Keep the message channel open for the response
        return true;
      }
    });
  } catch (error) {
    console.error('Script injection error:', error);
    updateStatus('Failed to read setlist: ' + error.message);
  }
});

function updateStatus(message, isLoading = false, type = '', isHtml = false) {
  const status = document.getElementById('status');
  if (isHtml) {
    status.innerHTML = message;
  } else {
    status.textContent = message;
  }
  
  status.className = type;
  if (isLoading) {
    status.style.color = '#666';
    status.style.fontStyle = 'italic';
  } else {
    status.style.color = '';
    status.style.fontStyle = '';
  }
}

function grabSetlist() {
  try {
    // Add debug logging to see what we're finding
    console.log('Looking for songs...');
    
    // Try multiple possible selectors
    const songElements = document.querySelectorAll('a.songLabel') ||
                        document.querySelectorAll('.songPart a') ||
                        document.querySelectorAll('.song-name') ||
                        document.querySelectorAll('[itemprop="name"]');
    
    console.log('Found song elements:', songElements);
    
    // Get all songs and handle multiple songs per line
    const songs = Array.from(songElements).flatMap(songElement => {
      const songText = songElement.textContent.trim();
      // Split by "/" and trim each song name
      return songText.split('/').map(song => song.trim());
    });

    console.log('Extracted songs (after splitting):', songs);

    // Get artist - try multiple selectors
    const artistElement = 
      document.querySelector('div.breadcrumb a[href*="/setlists/"]') ||
      document.querySelector('h1.artist-header a') ||
      document.querySelector('.setlistHeadline h1 a');
    
    console.log('Found artist element:', artistElement);
    
    if (!artistElement) {
      throw new Error('Could not find artist name on the page');
    }
    const artist = artistElement.textContent.trim();

    // Get date - try multiple selectors
    const dateElement = 
      document.querySelector('div.eventDate') ||
      document.querySelector('span.value[itemprop="startDate"]') ||
      document.querySelector('.dateBlock');
    
    console.log('Found date element:', dateElement);
    
    if (!dateElement) {
      throw new Error('Could not find event date on the page');
    }
    const eventDate = dateElement.textContent.trim();

    // Get venue information
    const venueElement = document.querySelector('span a[href*="/venue/"]');
    console.log('Found venue element:', venueElement);
    
    if (!venueElement) {
      throw new Error('Could not find venue information on the page');
    }
    const venue = venueElement.textContent.trim();
    
    // Extract city from venue (everything after the first comma)
    const city = venue.split(',').slice(1).join(',').trim();

    if (songs.length === 0) {
      // Log the entire relevant HTML to help debug
      console.log('Page HTML for debugging:', document.querySelector('.setlistList')?.outerHTML || 'No setlist container found');
      throw new Error('No songs found on the page. Make sure you are on a setlist page.');
    }

    console.log('Final setlist data:', { songs, artist, eventDate, venue, city });

    chrome.runtime.sendMessage({
      type: 'CREATE_PLAYLIST',
      data: { songs, artist, eventDate, venue, city }
    });
  } catch (error) {
    console.error('Error grabbing setlist:', error);
    chrome.runtime.sendMessage({
      type: 'ERROR',
      error: error.message
    });
  }
}

// Add this function to save popup state
async function savePopupState(state) {
  await chrome.storage.local.set({ popupState: state });
}

// Add this function to restore popup state
async function restorePopupState() {
  const { popupState } = await chrome.storage.local.get('popupState');
  if (popupState) {
    const status = document.getElementById('status');
    if (popupState.type === 'SONG_SELECTION') {
      createSongSelectionDialog(popupState.data);
    } else if (popupState.type === 'SUCCESS') {
      const statusHtml = createSuccessMessage(popupState.data);
      updateStatus(statusHtml, false, 'success', true);
    }
  }
}

// Add this function to create song selection dialog
function createSongSelectionDialog(data) {
  const { originalSong, options, searchQuery } = data;
  let currentOffset = 3;
  
  const dialog = document.createElement('div');
  dialog.className = 'song-options';
  dialog.innerHTML = `
    <p>Multiple matches found for "${originalSong}". Please select the correct version:</p>
    <div class="song-options-list">
      ${options.map((option, index) => `
        <div class="song-option" data-uri="${option.uri}" data-name="${option.name}" data-artist="${option.artist}">
          <img src="${option.albumImage || 'default-album.png'}" alt="Album art" class="album-art">
          <div class="song-option-details">
            <div class="song-option-title">${option.name}</div>
            <div class="song-option-artist">by ${option.artist}</div>
            <div class="song-option-album">from ${option.album}</div>
          </div>
        </div>
      `).join('')}
    </div>
    <div class="song-selection-actions">
      <button class="show-more-btn">Show More Options</button>
      <button class="skip-btn">Skip This Song</button>
    </div>
  `;

  const status = document.getElementById('status');
  status.innerHTML = '';
  status.appendChild(dialog);

  attachSongSelectionHandlers(dialog, data, currentOffset);
}

// Add this function to create success message HTML
function createSuccessMessage(data) {
  return `
    <div class="success">
      <p>${data.message}</p>
      <p class="venue-info">Venue: ${data.venue}</p>
      <p>Added ${data.addedSongs.length + data.addedWithDifferentArtist.length} of ${data.totalSongs} songs</p>
      <a href="${data.playlistUrl}" target="_blank" class="playlist-link">Open Playlist</a>
      
      ${data.addedWithDifferentArtist.length > 0 ? `
        <div class="different-artist-songs">
          <p>Songs added with different artists:</p>
          <ul>
            ${data.addedWithDifferentArtist.map(item => 
              `<li>
                <span class="original">${item.originalSong}</span>
                <span class="arrow">&rarr;</span>
                <span class="found">${item.foundTrack.name}</span>
                <span class="artist">by ${item.foundTrack.artist}</span>
                ${item.originalSong.includes('/') ? '<span class="medley-note">(Part of medley)</span>' : ''}
              </li>`
            ).join('')}
          </ul>
        </div>
      ` : ''}
      
      ${data.missingSongs.length > 0 ? `
        <div class="missing-songs">
          <p>Songs not found on Spotify:</p>
          <ul>
            ${data.missingSongs.map(song => 
              `<li>${song}${song.includes('/') ? ' (Part of medley)' : ''}</li>`
            ).join('')}
          </ul>
        </div>
      ` : ''}
    </div>
  `;
}

// Add this function to create progress UI
function createProgressUI(progressData) {
  const { currentSong, processed, total, added } = progressData;
  const percentage = (processed / total) * 100;
  
  return `
    <div class="progress-container">
      <div class="progress-text">Creating playlist...</div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${percentage}%"></div>
      </div>
      <div class="progress-stats">
        <span>Processed: ${processed}/${total}</span>
        <span>Added: ${added}/${total}</span>
      </div>
      ${currentSong ? `
        <div class="current-song">
          Currently processing: ${currentSong}
        </div>
      ` : ''}
    </div>
  `;
}

// Update the message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ERROR') {
    updateStatus('Error: ' + message.error, false, 'error');
    savePopupState(message);
  } else if (message.type === 'SUCCESS') {
    const statusHtml = createSuccessMessage(message.data);
    updateStatus(statusHtml, false, 'success', true);
    savePopupState(message);
  } else if (message.type === 'SONG_SELECTION') {
    createSongSelectionDialog(message.data);
    savePopupState(message);
    return true;
  } else if (message.type === 'PROGRESS_UPDATE') {
    const progressHtml = createProgressUI(message.data);
    updateStatus(progressHtml, false, '', true);
    savePopupState(message);
  }
});

// Add this function to handle song selection events
function attachSongSelectionHandlers(dialog, data, currentOffset) {
  // Handle "Show More" button
  dialog.querySelector('.show-more-btn').addEventListener('click', async () => {
    try {
      const token = (await chrome.storage.local.get('spotifyToken')).spotifyToken;
      const response = await fetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(data.searchQuery)}&type=track&limit=3&offset=${currentOffset}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        }
      );
      const responseData = await response.json();
      
      if (responseData.tracks.items.length > 0) {
        currentOffset += 3;
        const optionsList = dialog.querySelector('.song-options-list');
        
        // Add new options to the list
        responseData.tracks.items.forEach(track => {
          const option = document.createElement('div');
          option.className = 'song-option';
          option.dataset.uri = track.uri;
          option.dataset.name = track.name;
          option.dataset.artist = track.artists[0].name;
          option.innerHTML = `
            <img src="${track.album.images[1]?.url || track.album.images[0]?.url || 'default-album.png'}" alt="Album art" class="album-art">
            <div class="song-option-details">
              <div class="song-option-title">${track.name}</div>
              <div class="song-option-artist">by ${track.artists[0].name}</div>
              <div class="song-option-album">from ${track.album.name}</div>
            </div>
          `;
          optionsList.appendChild(option);
        });

        // Update stored state with new options
        data.options = [...data.options, ...responseData.tracks.items.map(track => ({
          uri: track.uri,
          name: track.name,
          artist: track.artists[0].name,
          album: track.album.name,
          albumImage: track.album.images[1]?.url || track.album.images[0]?.url
        }))];
        savePopupState({ type: 'SONG_SELECTION', data });

        if (responseData.tracks.items.length < 3) {
          dialog.querySelector('.show-more-btn').style.display = 'none';
        }
      } else {
        dialog.querySelector('.show-more-btn').style.display = 'none';
      }
    } catch (error) {
      console.error('Error fetching more songs:', error);
    }
  });

  // Handle selection
  dialog.addEventListener('click', (e) => {
    const option = e.target.closest('.song-option');
    if (option) {
      dialog.querySelectorAll('.song-option').forEach(opt => opt.classList.remove('selected'));
      option.classList.add('selected');
      
      setTimeout(() => {
        // Send message to background script
        chrome.runtime.sendMessage({
          type: 'SONG_SELECTED',
          data: {
            uri: option.dataset.uri,
            name: option.dataset.name,
            artist: option.dataset.artist
          }
        });

        // Clear popup state and show processing message
        chrome.storage.local.remove('popupState');
        const status = document.getElementById('status');
        status.innerHTML = '<div class="progress-container"><div class="progress-text">Processing playlist...</div></div>';
      }, 300);
    }
  });

  // Update skip button handler
  dialog.querySelector('.skip-btn').addEventListener('click', () => {
    // Send skip message to background script
    chrome.runtime.sendMessage({ type: 'SONG_SKIPPED' });
    
    // Clear popup state and show processing message
    chrome.storage.local.remove('popupState');
    const status = document.getElementById('status');
    status.innerHTML = '<div class="progress-container"><div class="progress-text">Processing playlist...</div></div>';
  });
}

// Add this to restore state when popup opens
document.addEventListener('DOMContentLoaded', async () => {
  const { spotifyToken } = await chrome.storage.local.get('spotifyToken');
  if (spotifyToken) {
    await updateUserProfile(spotifyToken);
    await restorePopupState();
  }

  // Add click handler for creator link (blog)
  document.getElementById('creatorLink').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'https://rzhu.ca' });
  });

  // Add click handler for feedback link
  document.getElementById('feedbackLink').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'mailto:zetachan17@gmail.com?subject=Setlist to Spotify Feedback' });
  });

  // Add click handler for support link (ko-fi)
  document.getElementById('supportLink').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'https://ko-fi.com/zetachan' });
  });
}); 