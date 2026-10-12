import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import AppLayout from '@cloudscape-design/components/app-layout';
import TopNavigation from '@cloudscape-design/components/top-navigation';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import { ScenarioSelector } from './components/ScenarioSelector';

function App() {
  return (
    <Authenticator>
      {({ signOut, user }) => (
        <>
          <TopNavigation
            identity={{
              href: '#',
              title: 'AI-Assisted Call Center Agent Training - Admin',
            }}
            utilities={[
              {
                type: 'menu-dropdown',
                text: user?.signInDetails?.loginId || 'Admin',
                items: [
                  { id: 'signout', text: 'Sign Out' },
                ],
                onItemClick: ({ detail }) => {
                  if (detail.id === 'signout' && signOut) {
                    signOut();
                  }
                },
              },
            ]}
          />
          <AppLayout
            navigationHide
            toolsHide
            content={
              <ContentLayout
                header={
                  <Header
                    variant="h1"
                    description="Select a scenario and start a training call via Amazon Connect. Calls are scored automatically by Amazon Connect evaluations — review results in the Amazon Connect admin website."
                  >
                    Start Training Session
                  </Header>
                }
              >
                <ScenarioSelector />
              </ContentLayout>
            }
          />
        </>
      )}
    </Authenticator>
  );
}

export default App;
